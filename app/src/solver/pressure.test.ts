import { describe, it, expect } from 'vitest'
import { makeNode, makeEdge, graphToSolveRequest } from '../store/factory'
import type { RFNode } from '../store/factory'
import { solve } from './tsSolver'
import { resultWarnings } from '../store/validate'
import { EMPTY_RESULT, type SolveResult } from './contract'

// A boiler -> radiator loop, optionally with extra inline components.
function loop(boilerOverride?: Record<string, number>, extra: RFNode[] = []) {
  const b = makeNode('gas_boiler', 0, 0, boilerOverride)
  const r = makeNode('radiator', 0, 0)
  const nodes = [b, r, ...extra]
  const edges = [
    makeEdge(b.id, 'sup', r.id, 'sup', 'supply'),
    makeEdge(r.id, 'ret', b.id, 'ret', 'return'),
  ]
  return { b, r, nodes, edges, run: () => solve(graphToSolveRequest(nodes, edges)) }
}

describe('system pressure is a real static quantity (fill + thermal expansion)', () => {
  it('RISES when the water gets hotter — the working-heat-source case', () => {
    const cool = loop({ maxSupplyC: 45 }).run()
    const hot = loop({ maxSupplyC: 80 }).run()
    expect(hot.global.supplyC).toBeGreaterThan(cool.global.supplyC)
    // hotter loop -> more thermal expansion -> higher gauge pressure
    expect(hot.global.pressureKpa).toBeGreaterThan(cool.global.pressureKpa + 10)
  })

  it('is NOT dominated by pump head: pump differential is reported separately', () => {
    const r = loop().run()
    // headKpa (pump differential) is its own number, and pressure is no longer
    // just head + 1 bar (the old bug: pressureKpa - headKpa === 100 exactly)
    expect(r.global.headKpa).toBeGreaterThan(0)
    expect(Math.abs(r.global.pressureKpa - r.global.headKpa - 100)).toBeGreaterThan(1)
  })

  it('follows the fill-valve setpoint (setBar)', () => {
    const base = loop().run()
    const filled = loop({}, [makeNode('fill_valve', 0, 0, { setBar: 2.5 })]).run()
    // a 2.5 bar fill lifts the whole gauge well above the default ~1.2 bar fill
    expect(filled.global.pressureKpa).toBeGreaterThan(base.global.pressureKpa + 100)
  })

  it('a larger expansion vessel softens the thermal swing', () => {
    const small = loop({}, [makeNode('expansion_vessel', 0, 0, { volumeL: 8 })]).run()
    const big = loop({}, [makeNode('expansion_vessel', 0, 0, { volumeL: 80 })]).run()
    expect(big.global.pressureKpa).toBeLessThan(small.global.pressureKpa)
  })

  it('does NOT depressurise to 0 when the only pump is switched off', () => {
    const { b, nodes, edges } = loop()
    b.data.enabled = false // boiler (the only flow driver) off
    const r = solve(graphToSolveRequest(nodes, edges))
    expect(r.global.flowM3h).toBeLessThan(0.01) // flow stops
    // ...but the sealed system still holds its cold static pressure
    expect(r.global.pressureKpa).toBeGreaterThan(100)
    expect(r.global.pressureKpa).toBeLessThan(160)
  })
})

describe('heat-pump COP is clamped to a physical band', () => {
  const hpLoop = (override: Record<string, number>) => {
    const hp = makeNode('heat_pump', 0, 0, override)
    const rad = makeNode('radiator', 0, 0)
    const edges = [
      makeEdge(hp.id, 'sup', rad.id, 'sup', 'supply'),
      makeEdge(rad.id, 'ret', hp.id, 'ret', 'return'),
    ]
    return solve(graphToSolveRequest([hp, rad], edges))
  }

  it('never exceeds ~6.5 even with a high rated COP and warm source air', () => {
    // copRated 6 + 35 C source would give ~7.96 unclamped
    const r = hpLoop({ copRated: 6, sourceC: 35, maxSupplyC: 35, ratedKw: 12 })
    expect(r.global.cop).not.toBeNull()
    expect(r.global.cop as number).toBeLessThanOrEqual(6.5)
  })

  it('stays in band at a normal operating point', () => {
    const r = hpLoop({ maxSupplyC: 55 })
    expect(r.global.cop as number).toBeGreaterThanOrEqual(1.5)
    expect(r.global.cop as number).toBeLessThanOrEqual(6.5)
  })
})

describe('resultWarnings surfaces faults the topology check cannot see', () => {
  const twoPumps = () => [makeNode('circulator', 0, 0), makeNode('circulator', 0, 0)]
  // fighting is judged on REAL pipe flow (res.edges), not global.flowM3h — that
  // metric only counts heat-source throughput and reads 0 in source-less systems
  const resAt = (pipeFlow: number, pressureKpa: number): SolveResult => ({
    ...EMPTY_RESULT,
    global: { ...EMPTY_RESULT.global, flowM3h: pipeFlow, pressureKpa },
    edges: { e1: { flowM3h: pipeFlow, tempC: 50, line: 'supply', dir: 1 } },
  })

  it('flags two pumps fighting: 2+ drivers but ~zero flow', () => {
    const w = resultWarnings(twoPumps(), [], resAt(0, 120))
    expect(w.some((x) => x.key === 'warn.pumpsFighting')).toBe(true)
  })

  it('names the culprits and carries their node ids for highlighting', () => {
    const pumps = twoPumps()
    const w = resultWarnings(pumps, [], resAt(0, 120))
    const fight = w.find((x) => x.key === 'warn.pumpsFighting')!
    expect(fight.nodeIds).toEqual([pumps[0].id, pumps[1].id])
    expect(typeof fight.vars?.names).toBe('string')
    expect((fight.vars!.names as string).length).toBeGreaterThan(0)
  })

  it('does NOT flag fighting when flow is healthy', () => {
    const w = resultWarnings(twoPumps(), [], resAt(1.2, 150))
    expect(w.some((x) => x.key === 'warn.pumpsFighting')).toBe(false)
  })

  it('does NOT flag fighting for a single pump at zero flow (off / blocked)', () => {
    const w = resultWarnings([makeNode('circulator', 0, 0)], [], resAt(0, 120))
    expect(w.some((x) => x.key === 'warn.pumpsFighting')).toBe(false)
  })

  it('does NOT flag two pumps across a hydraulic separator (global flow reads 0)', () => {
    // no heat source -> global.flowM3h is 0, but both loops carry real pipe flow;
    // the separator decouples them so they cannot fight
    const nodes = [
      makeNode('circulator', 0, 0),
      makeNode('hydraulic_separator', 0, 0),
      makeNode('circulator', 0, 0),
    ]
    const w = resultWarnings(nodes, [], resAt(1.2, 120))
    expect(w.some((x) => x.key === 'warn.pumpsFighting')).toBe(false)
  })

  it('flags over-pressure at/above the relief limit', () => {
    const w = resultWarnings(twoPumps(), [], resAt(1, 320))
    expect(w.some((x) => x.key === 'warn.pressureHigh')).toBe(true)
  })

  it('flags under-pressure below 0.8 bar', () => {
    const w = resultWarnings([makeNode('circulator', 0, 0)], [], resAt(1, 60))
    expect(w.some((x) => x.key === 'warn.pressureLow')).toBe(true)
  })
})

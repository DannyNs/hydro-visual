import { describe, it, expect } from 'vitest'
import { makeEdge, makeNode, syncPipeLengths, graphToSolveRequest } from './factory'
import { validateGraph, resultWarnings } from './validate'
import { sanitizeGraph } from './persist'
import type { RFNode, RFEdge } from './factory'
import { EMPTY_RESULT } from '../solver/contract'
import type { SolveResult } from '../solver/contract'

const globalAt = (pressureKpa: number): SolveResult => ({
  ...EMPTY_RESULT,
  global: {
    flowM3h: 1,
    headKpa: 20,
    pressureKpa,
    supplyC: 50,
    returnC: 42,
    deltaC: 8,
    heatKw: 5,
    cop: null,
  },
})

describe('resultWarnings — pressure-relief threshold', () => {
  it('a 5 bar relief valve raises the warning threshold above the 3 bar default', () => {
    const relief = makeNode('pressure_relief', 0, 0, { setBar: 5 })
    // 3.5 bar: below the placed valve's setpoint — no warning
    expect(
      resultWarnings([relief], [], globalAt(350)).some((w) => w.key === 'warn.pressureHigh'),
    ).toBe(false)
    // 5.2 bar: above it — warn
    expect(
      resultWarnings([relief], [], globalAt(520)).some((w) => w.key === 'warn.pressureHigh'),
    ).toBe(true)
  })

  it('with no relief valve the 3 bar fallback applies', () => {
    expect(
      resultWarnings([makeNode('radiator', 0, 0)], [], globalAt(310)).some(
        (w) => w.key === 'warn.pressureHigh',
      ),
    ).toBe(true)
  })
})

describe('validateGraph — noDriver respects the on/off switch', () => {
  it('a switched-off circulator does not count as a flow driver', () => {
    const pump = makeNode('circulator', 0, 0)
    pump.data.enabled = false
    expect(validateGraph([pump], []).some((w) => w.key === 'warn.noDriver')).toBe(true)
    pump.data.enabled = true
    expect(validateGraph([pump], []).some((w) => w.key === 'warn.noDriver')).toBe(false)
  })
})

describe('sanitizeGraph — corrupt import safety', () => {
  it('drops unknown-kind nodes and their dangling edges', () => {
    const good = makeNode('radiator', 0, 0)
    const bad = {
      ...makeNode('circulator', 0, 0),
      data: { kind: 'flux_capacitor', label: '?', params: {} },
    } as unknown as RFNode
    const e1 = makeEdge(good.id, 'ret', bad.id, 'in', 'return')
    const g = sanitizeGraph({ nodes: [good, bad], edges: [e1] })
    expect(g.nodes.map((n) => n.id)).toEqual([good.id])
    expect(g.edges).toEqual([])
  })

  it('a sanitized graph builds a solve request without throwing', () => {
    const good = makeNode('radiator', 0, 0)
    const g = sanitizeGraph({ nodes: [good], edges: [] })
    expect(() => graphToSolveRequest(g.nodes, g.edges)).not.toThrow()
  })
})

describe('syncPipeLengths — hand-typed lengths survive re-sync', () => {
  it('skips edges flagged lengthManual, recomputes the rest', () => {
    const a = makeNode('gas_boiler', 0, 0)
    const b = makeNode('radiator', 500, 0)
    const manual: RFEdge = makeEdge(a.id, 'sup', b.id, 'sup', 'supply')
    manual.data!.lengthM = 42
    manual.data!.lengthManual = true
    const auto: RFEdge = makeEdge(b.id, 'ret', a.id, 'ret', 'return')
    syncPipeLengths([a, b], [manual, auto])
    expect(manual.data!.lengthM).toBe(42)
    expect(auto.data!.lengthM).not.toBe(4) // re-derived from the drawn distance
  })
})

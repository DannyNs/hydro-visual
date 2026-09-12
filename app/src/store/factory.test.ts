import { describe, it, expect } from 'vitest'
import { makeEdge, makeNode, nextId, syncSeq, graphToSolveRequest } from './factory'
import type { RFNode } from './factory'
import { solve } from '../solver/tsSolver'

// A shut device must block flow even when a pump elsewhere is pushing. Loop:
// gas boiler (built-in pump) -> zone valve -> radiator -> back to the boiler.
describe('a switched-off zone valve blocks flow (not just stops its own pump)', () => {
  const loop = (zvEnabled: boolean) => {
    const s = makeNode('gas_boiler', 0, 0) // built-in pump drives the loop
    const zv = makeNode('zone_valve', 0, 0)
    if (!zvEnabled) zv.data.enabled = false
    const e = makeNode('radiator', 0, 0)
    const edges = [
      makeEdge(s.id, 'sup', zv.id, 'in', 'supply'),
      makeEdge(zv.id, 'out', e.id, 'sup', 'supply'),
      makeEdge(e.id, 'ret', s.id, 'ret', 'return'),
    ]
    const r = solve(graphToSolveRequest([s, zv, e], edges))
    return Math.max(...Object.values(r.edges).map((x) => x.flowM3h))
  }

  it('off: flow is blocked (below the flow-animation threshold)', () => {
    expect(loop(false)).toBeLessThan(0.03)
  })
  it('on: water flows', () => {
    expect(loop(true)).toBeGreaterThan(0.1)
  })
})

// A switched-off powered device must be remapped so the solver renders it inert
// (no heat, no pump head) but still pipe-like — its body passes flow at small
// resistance; only valves shut. No engine change needed.
describe('on/off device remapping (graphToSolveRequest)', () => {
  const off = (kind: Parameters<typeof makeNode>[0]): RFNode => {
    const n = makeNode(kind, 0, 0)
    n.data.enabled = false
    return n
  }
  const solverNode = (n: RFNode) => graphToSolveRequest([n], []).nodes[0]

  it('disabled heat source: no head/heat, but its body still passes flow', () => {
    const s = solverNode(off('heat_pump'))
    expect(s.role).toBe('passive') // not tallied as a heat source, adds no heat
    expect(s.params.kKpa).toBeLessThan(1) // pipe-like body resistance, not shut
  })

  it('disabled pump: no head, but its body still passes flow', () => {
    const s = solverNode(off('circulator'))
    expect(s.role).toBe('passive')
    expect(s.params.kKpa).toBeLessThan(1)
  })

  it('disabled pump group: both rails pass at small resistance (no head)', () => {
    const s = solverNode(off('direct_group'))
    expect(s.role).toBe('manifold')
    expect(s.params.kKpa).toBeLessThan(1)
  })

  it('disabled zone valve shuts (high-resistance passive)', () => {
    const v = solverNode(off('zone_valve'))
    expect(v.role).toBe('passive')
    expect(v.params.kKpa).toBeGreaterThan(1000)
  })

  it('enabled device is passed through unchanged', () => {
    const n = makeNode('heat_pump', 0, 0) // enabled undefined = on
    const s = graphToSolveRequest([n], []).nodes[0]
    expect(s.role).toBe('source')
    expect(s.params.ratedKw).toBe(n.data.params.ratedKw)
    expect(s.params.h0Kpa).toBe(n.data.params.h0Kpa)
  })
})

// Off devices pass flow (body resistance); only closed valves block. Primary
// loop: boiler into a buffer; secondary loop off the buffer runs a circulator
// through either an OFF heat pump or an OFF zone valve, then a radiator.
describe('shared-buffer parasitic flow (off device passes, closed valve blocks)', () => {
  const sys = (midKind: 'heat_pump' | 'zone_valve') => {
    const s = makeNode('gas_boiler', 0, 0)
    const buf = makeNode('buffer_tank', 0, 0, { entriesPerSide: 2 })
    const mid = makeNode(midKind, 0, 0)
    mid.data.enabled = false
    const circ = makeNode('circulator', 0, 0)
    const e = makeNode('radiator', 0, 0)
    const nodes = [s, buf, mid, circ, e]
    const inPort = midKind === 'heat_pump' ? 'ret' : 'in'
    const outPort = midKind === 'heat_pump' ? 'sup' : 'out'
    const edges = [
      makeEdge(s.id, 'sup', buf.id, 'l0', 'supply'),
      makeEdge(buf.id, 'l1', s.id, 'ret', 'return'),
      makeEdge(buf.id, 'r0', circ.id, 'in', 'supply', 4, 22, 'secIn'),
      makeEdge(circ.id, 'out', mid.id, inPort, 'supply', 4, 22, 'midIn'),
      makeEdge(mid.id, outPort, e.id, 'sup', 'supply', 4, 22, 'midOut'),
      makeEdge(e.id, 'ret', buf.id, 'r1', 'return', 4, 22, 'secRet'),
    ]
    const r = solve(graphToSolveRequest(nodes, edges))
    return Math.max(r.edges.midIn.flowM3h, r.edges.midOut.flowM3h)
  }

  it('off heat pump: the circulator still drives flow through its body', () => {
    expect(sys('heat_pump')).toBeGreaterThan(0.1)
  })

  it('off zone valve: the secondary loop is blocked', () => {
    expect(sys('zone_valve')).toBeLessThan(0.03)
  })
})

// Regression for the "drawing a new pipe deletes an existing pipe" bug: a graph
// restored from localStorage never ran buildSeed (which advances the id
// counter), so the counter sat at 1 and the next makeEdge reused `e1`, colliding
// with the restored edge -> React rendered two edges with key `e1` and dropped
// one. syncSeq pushes the counter past any restored/imported ids.
describe('id generation collision-safety (syncSeq)', () => {
  it('mints ids that never reuse those in a restored graph', () => {
    const restoredEdgeIds = Array.from({ length: 17 }, (_, i) => `e${i + 1}`)
    const restoredNodeIds = ['hp', 'dirt', 'buf', 'rad1', 'rad2', 'r5']
    syncSeq([...restoredNodeIds, ...restoredEdgeIds])

    const e = makeEdge('a', 'o', 'b', 'i')
    expect(restoredEdgeIds).not.toContain(e.id)

    const n = makeNode('radiator', 0, 0)
    expect(restoredNodeIds).not.toContain(n.id)

    const id = nextId('e')
    expect([...restoredEdgeIds, e.id]).not.toContain(id)
  })

  it('only moves the counter forward (a lower resync never rewinds it)', () => {
    syncSeq(['e1000'])
    const a = Number(makeEdge('a', 'o', 'b', 'i').id.slice(1))
    syncSeq(['e5']) // lower than current — must be ignored
    const b = Number(makeEdge('a', 'o', 'b', 'i').id.slice(1))
    expect(b).toBeGreaterThan(a)
  })
})

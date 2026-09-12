import { describe, it, expect } from 'vitest'
import { makeNode, makeEdge, graphToSolveRequest } from '../store/factory'
import { solve } from './tsSolver'
import { resultWarnings } from '../store/validate'

// Primary/secondary setup: two pumps on opposite sides of a hydraulic separator.
// They CANNOT fight — the separator decouples them hydraulically. Regression for
// the false "pumps fighting" warning that fired because global.flowM3h (derived
// from heat-source throughput only) reads 0 in any system without a source.
describe('hydraulic separator decouples pumps (no false fight)', () => {
  const setup = () => {
    const p1 = makeNode('circulator', 0, 0)
    const sep = makeNode('hydraulic_separator', 200, 0)
    const p2 = makeNode('circulator', 400, 0)
    const e1 = makeNode('radiator', 0, -200)
    const e2 = makeNode('radiator', 400, -200)
    const nodes = [p1, sep, p2, e1, e2]
    const edges = [
      makeEdge(p1.id, 'out', sep.id, 'l0', 'supply'),
      makeEdge(sep.id, 'l1', e1.id, 'sup', 'return'),
      makeEdge(e1.id, 'ret', p1.id, 'in', 'auto'),
      makeEdge(p2.id, 'out', sep.id, 'r0', 'supply'),
      makeEdge(sep.id, 'r1', e2.id, 'sup', 'return'),
      makeEdge(e2.id, 'ret', p2.id, 'in', 'auto'),
    ]
    return { nodes, edges }
  }

  it('both loops carry real flow and no fight warning fires', () => {
    const { nodes, edges } = setup()
    const res = solve(graphToSolveRequest(nodes, edges))
    // both sides of the separator actually circulate
    expect(res.edges[edges[0].id].flowM3h).toBeGreaterThan(0.5)
    expect(res.edges[edges[3].id].flowM3h).toBeGreaterThan(0.5)
    // no heat source -> global.flowM3h reads 0 (the old check would false-flag a fight)
    expect(res.global.flowM3h).toBeLessThan(0.02)
    const w = resultWarnings(nodes, edges, res)
    expect(w.some((x) => x.key === 'warn.pumpsFighting')).toBe(false)
  })
})

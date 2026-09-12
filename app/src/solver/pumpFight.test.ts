import { describe, it, expect } from 'vitest'
import type { RFNode, RFEdge } from '../store/factory'
import { makeNode, makeEdge, graphToSolveRequest } from '../store/factory'
import { solve } from './tsSolver'
import { resultWarnings } from '../store/validate'

function fightWarning(nodes: RFNode[], edges: RFEdge[]) {
  const res = solve(graphToSolveRequest(nodes, edges))
  return resultWarnings(nodes, edges, res).find((w) => w.key === 'warn.pumpsFighting')
}

describe('pump-fight detection', () => {
  it('out-to-out only (dead-headed): warns', () => {
    const p1 = makeNode('circulator', 0, 0)
    const p2 = makeNode('circulator', 200, 0)
    const w = fightWarning([p1, p2], [makeEdge(p1.id, 'out', p2.id, 'out')])
    expect(w).toBeDefined()
    expect(w!.nodeIds).toEqual(expect.arrayContaining([p1.id, p2.id]))
  })

  it('full opposed loop, identical pumps: warns', () => {
    const p1 = makeNode('circulator', 0, 0)
    const p2 = makeNode('circulator', 200, 0)
    const w = fightWarning(
      [p1, p2],
      [makeEdge(p1.id, 'out', p2.id, 'out'), makeEdge(p1.id, 'in', p2.id, 'in')],
    )
    expect(w).toBeDefined()
  })

  it('full opposed loop, unequal heads: warns (back-driven pump)', () => {
    // The strong pump settles at an equilibrium pushing fluid BACKWARDS through
    // the weak one — real pipe flow stays ~1.8 m³/h, so only the per-driver
    // back-drive signature catches this fight.
    const p1 = makeNode('circulator', 0, 0, { h0Kpa: 60 })
    const p2 = makeNode('circulator', 200, 0, { h0Kpa: 30 })
    const edges = [makeEdge(p1.id, 'out', p2.id, 'out'), makeEdge(p1.id, 'in', p2.id, 'in')]
    const res = solve(graphToSolveRequest([p1, p2], edges))
    // sanity: the weak pump really is back-driven (flow enters its out port)
    const maxPipeFlow = Object.values(res.edges).reduce((m, e) => Math.max(m, e.flowM3h), 0)
    expect(maxPipeFlow).toBeGreaterThan(1)
    const w = resultWarnings([p1, p2], edges, res).find((x) => x.key === 'warn.pumpsFighting')
    expect(w).toBeDefined()
    expect(w!.nodeIds).toEqual(expect.arrayContaining([p1.id, p2.id]))
  })

  it('healthy: two pumps in series aiding: no warning', () => {
    const p1 = makeNode('circulator', 0, 0)
    const p2 = makeNode('circulator', 200, 0)
    const r1 = makeNode('radiator', 400, 0)
    const w = fightWarning(
      [p1, p2, r1],
      [
        makeEdge(p1.id, 'out', p2.id, 'in'),
        makeEdge(p2.id, 'out', r1.id, 'sup'),
        makeEdge(r1.id, 'ret', p1.id, 'in'),
      ],
    )
    expect(w).toBeUndefined()
  })

  it('healthy: parallel pumps into one loop: no warning', () => {
    const p1 = makeNode('circulator', 0, 0)
    const p2 = makeNode('circulator', 0, -200)
    const r1 = makeNode('radiator', 300, 0)
    const w = fightWarning(
      [p1, p2, r1],
      [
        makeEdge(p1.id, 'out', r1.id, 'sup'),
        makeEdge(r1.id, 'ret', p1.id, 'in'),
        makeEdge(p2.id, 'out', r1.id, 'sup'),
        makeEdge(r1.id, 'ret', p2.id, 'in'),
      ],
    )
    expect(w).toBeUndefined()
  })
})

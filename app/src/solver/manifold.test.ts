import { describe, it, expect } from 'vitest'
import { solve } from './tsSolver'
import type { SolveRequest } from './contract'

// A manifold is a distributor: the temperature it reports as "supply" must equal
// the temperature feeding it. It must not lose value on the supply rail.
describe('manifold supply temperature pass-through', () => {
  const directFeed = (circuits: number): SolveRequest => {
    const nodes: SolveRequest['nodes'] = [
      { id: 's', role: 'source', params: { ratedKw: 12, maxSupplyC: 35, h0Kpa: 50, qMaxM3h: 3 } },
      { id: 'm', role: 'manifold', params: { circuits } },
    ]
    const edges: SolveRequest['edges'] = [
      { id: 'feed', from: 's', fromPort: 'sup', to: 'm', toPort: 'sup_in', line: 'supply', lengthM: 2, diameterMm: 28 },
      { id: 'ret', from: 'm', fromPort: 'ret_out', to: 's', toPort: 'ret', line: 'return', lengthM: 2, diameterMm: 28 },
    ]
    for (let i = 0; i < circuits; i++) {
      nodes.push({ id: `e${i}`, role: 'emitter', params: { ratedKw: 2, ratedExcessC: 15, roomC: 20, exponent: 1.1 } })
      edges.push({ id: `cs${i}`, from: 'm', fromPort: `sup${i}`, to: `e${i}`, toPort: 'sup', line: 'supply', lengthM: 3, diameterMm: 16 })
      edges.push({ id: `cr${i}`, from: `e${i}`, fromPort: 'ret', to: 'm', toPort: `ret${i}`, line: 'return', lengthM: 3, diameterMm: 16 })
    }
    return { nodes, edges, fluid: { cpJkgK: 4186, rhoKgM3: 997 }, ambientC: 20, mode: 'steady' }
  }

  for (const circuits of [1, 3, 6]) {
    it(`${circuits} circuits: manifold supplyC matches the feed pipe`, () => {
      const r = solve(directFeed(circuits))
      const feedTemp = r.edges['feed'].tempC
      expect(r.nodes['m'].supplyC).toBeDefined()
      expect(Math.abs((r.nodes['m'].supplyC as number) - feedTemp)).toBeLessThan(0.2)
    })
  }

  it('fed by a mixing group, the manifold shows the group outlet temp (no extra loss)', () => {
    const req: SolveRequest = {
      nodes: [
        { id: 's', role: 'source', params: { ratedKw: 14, maxSupplyC: 55, h0Kpa: 50, qMaxM3h: 3 } },
        { id: 'mg', role: 'group', params: { h0Kpa: 50, qMaxM3h: 2, targetSupplyC: 35 } },
        { id: 'm', role: 'manifold', params: { circuits: 3 } },
      ],
      edges: [
        { id: 'pf', from: 's', fromPort: 'sup', to: 'mg', toPort: 'pri_in', line: 'supply', lengthM: 2, diameterMm: 28 },
        { id: 'pr', from: 'mg', fromPort: 'pri_out', to: 's', toPort: 'ret', line: 'return', lengthM: 2, diameterMm: 28 },
        { id: 'feed', from: 'mg', fromPort: 'sec_out', to: 'm', toPort: 'sup_in', line: 'supply', lengthM: 2, diameterMm: 28 },
        { id: 'mret', from: 'm', fromPort: 'ret_out', to: 'mg', toPort: 'sec_in', line: 'return', lengthM: 2, diameterMm: 28 },
      ],
      fluid: { cpJkgK: 4186, rhoKgM3: 997 }, ambientC: 20, mode: 'steady',
    }
    for (let i = 0; i < 3; i++) {
      req.nodes.push({ id: `e${i}`, role: 'emitter', params: { ratedKw: 2, ratedExcessC: 15, roomC: 21, exponent: 1.1 } })
      req.edges.push({ id: `cs${i}`, from: 'm', fromPort: `sup${i}`, to: `e${i}`, toPort: 'sup', line: 'supply', lengthM: 4, diameterMm: 16 })
      req.edges.push({ id: `cr${i}`, from: `e${i}`, fromPort: 'ret', to: 'm', toPort: `ret${i}`, line: 'return', lengthM: 4, diameterMm: 16 })
    }
    const r = solve(req)
    expect(Math.abs((r.nodes['m'].supplyC as number) - r.edges['feed'].tempC)).toBeLessThan(0.3)
  })
})

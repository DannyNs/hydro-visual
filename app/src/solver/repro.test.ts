import { describe, it } from 'vitest'
import { solve } from './tsSolver'
import type { SolveRequest } from './contract'

const FLUID = { cpJkgK: 4186, rhoKgM3: 997 }
type E = SolveRequest['edges'][number]
const pipe = (id: string, from: string, fp: string, to: string, tp: string, line: 'supply' | 'return' = 'supply'): E =>
  ({ id, from, fromPort: fp, to, toPort: tp, line, lengthM: 3, diameterMm: 20 })

// Per-node net signed pipe flow (out - in). Should be ~0 at every node if mass is conserved.
function nets(req: SolveRequest) {
  const r = solve(req)
  const net = new Map<string, number>()
  for (const n of req.nodes) net.set(n.id, 0)
  for (const e of req.edges) {
    const er = r.edges[e.id]
    if (!er) continue
    const f = er.flowM3h * (er.dir ?? 0) // + leaves source, enters target
    net.set(e.from, (net.get(e.from) ?? 0) - f)
    net.set(e.to, (net.get(e.to) ?? 0) + f)
  }
  const rows = [...net.entries()].map(([id, v]) => `${id}=${v.toFixed(5)}`).join('  ')
  let max = 0, worst = ''
  for (const [id, v] of net) if (Math.abs(v) > max) { max = Math.abs(v); worst = id }
  return { r, rows, max, worst }
}

describe('REPRO: where does the imbalance land', () => {
  it('tee — tee is node[0] (owns port 0)', () => {
    const req: SolveRequest = {
      nodes: [
        { id: 't1', role: 'junction', params: {} },
        { id: 's', role: 'source', params: { ratedKw: 10, maxSupplyC: 50, h0Kpa: 50, qMaxM3h: 3 } },
        { id: 't2', role: 'junction', params: {} },
        { id: 'e1', role: 'emitter', params: { ratedKw: 3, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
        { id: 'e2', role: 'emitter', params: { ratedKw: 2, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
      ],
      edges: [
        pipe('p0', 's', 'sup', 't1', 'a'),
        pipe('p1', 't1', 'b', 'e1', 'sup'),
        pipe('p2', 't1', 'c', 'e2', 'sup'),
        pipe('p3', 'e1', 'ret', 't2', 'a', 'return'),
        pipe('p4', 'e2', 'ret', 't2', 'b', 'return'),
        pipe('p5', 't2', 'c', 's', 'ret', 'return'),
      ],
      fluid: FLUID, ambientC: 20, mode: 'steady',
    }
    const { r, rows, max, worst } = nets(req)
    console.log(`[tee-first] status=${r.status}  ${rows}\n           maxImbalance=${max.toExponential(3)} at "${worst}"`)
  })

  it('tee — source is node[0] (owns port 0)', () => {
    const req: SolveRequest = {
      nodes: [
        { id: 's', role: 'source', params: { ratedKw: 10, maxSupplyC: 50, h0Kpa: 50, qMaxM3h: 3 } },
        { id: 't1', role: 'junction', params: {} },
        { id: 't2', role: 'junction', params: {} },
        { id: 'e1', role: 'emitter', params: { ratedKw: 3, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
        { id: 'e2', role: 'emitter', params: { ratedKw: 2, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
      ],
      edges: [
        pipe('p0', 's', 'sup', 't1', 'a'),
        pipe('p1', 't1', 'b', 'e1', 'sup'),
        pipe('p2', 't1', 'c', 'e2', 'sup'),
        pipe('p3', 'e1', 'ret', 't2', 'a', 'return'),
        pipe('p4', 'e2', 'ret', 't2', 'b', 'return'),
        pipe('p5', 't2', 'c', 's', 'ret', 'return'),
      ],
      fluid: FLUID, ambientC: 20, mode: 'steady',
    }
    const { r, rows, max, worst } = nets(req)
    console.log(`[tee-srcfirst] status=${r.status}  ${rows}\n           maxImbalance=${max.toExponential(3)} at "${worst}"`)
  })

  it('manifold — manifold is node[0], all lines correct', () => {
    const nodes: SolveRequest['nodes'] = [
      { id: 'm', role: 'manifold', params: { circuits: 4 } },
      { id: 's', role: 'source', params: { ratedKw: 12, maxSupplyC: 45, h0Kpa: 55, qMaxM3h: 3 } },
    ]
    const edges: E[] = [
      pipe('feed', 's', 'sup', 'm', 'sup_in'),
      pipe('mret', 'm', 'ret_out', 's', 'ret', 'return'),
    ]
    for (let i = 0; i < 4; i++) {
      nodes.push({ id: `e${i}`, role: 'emitter', params: { ratedKw: 1.5, ratedExcessC: 15, roomC: 21, exponent: 1.1 } })
      edges.push(pipe(`cs${i}`, 'm', `sup${i}`, `e${i}`, 'sup'))
      edges.push(pipe(`cr${i}`, `e${i}`, 'ret', 'm', `ret${i}`, 'return'))
    }
    const req: SolveRequest = { nodes, edges, fluid: FLUID, ambientC: 20, mode: 'steady' }
    const { r, rows, max, worst } = nets(req)
    console.log(`[man-first] status=${r.status}  ${rows}\n           maxImbalance=${max.toExponential(3)} at "${worst}"`)
  })

  it('manifold — source is node[0], all lines correct', () => {
    const nodes: SolveRequest['nodes'] = [
      { id: 's', role: 'source', params: { ratedKw: 12, maxSupplyC: 45, h0Kpa: 55, qMaxM3h: 3 } },
      { id: 'm', role: 'manifold', params: { circuits: 4 } },
    ]
    const edges: E[] = [
      pipe('feed', 's', 'sup', 'm', 'sup_in'),
      pipe('mret', 'm', 'ret_out', 's', 'ret', 'return'),
    ]
    for (let i = 0; i < 4; i++) {
      nodes.push({ id: `e${i}`, role: 'emitter', params: { ratedKw: 1.5, ratedExcessC: 15, roomC: 21, exponent: 1.1 } })
      edges.push(pipe(`cs${i}`, 'm', `sup${i}`, `e${i}`, 'sup'))
      edges.push(pipe(`cr${i}`, `e${i}`, 'ret', 'm', `ret${i}`, 'return'))
    }
    const req: SolveRequest = { nodes, edges, fluid: FLUID, ambientC: 20, mode: 'steady' }
    const { r, rows, max, worst } = nets(req)
    console.log(`[man-srcfirst] status=${r.status}  ${rows}\n           maxImbalance=${max.toExponential(3)} at "${worst}"`)
  })

  it('manifold — one circuit return edge is line:auto (rail mis-split)', () => {
    const nodes: SolveRequest['nodes'] = [
      { id: 's', role: 'source', params: { ratedKw: 12, maxSupplyC: 45, h0Kpa: 55, qMaxM3h: 3 } },
      { id: 'm', role: 'manifold', params: { circuits: 4 } },
    ]
    const edges: E[] = [
      pipe('feed', 's', 'sup', 'm', 'sup_in'),
      pipe('mret', 'm', 'ret_out', 's', 'ret', 'return'),
    ]
    for (let i = 0; i < 4; i++) {
      nodes.push({ id: `e${i}`, role: 'emitter', params: { ratedKw: 1.5, ratedExcessC: 15, roomC: 21, exponent: 1.1 } })
      edges.push(pipe(`cs${i}`, 'm', `sup${i}`, `e${i}`, 'sup'))
      // circuit 2's return is 'auto' -> defaults to supply rail (mis-split)
      const line = i === 2 ? ('auto' as unknown as 'return') : 'return'
      edges.push(pipe(`cr${i}`, `e${i}`, 'ret', 'm', `ret${i}`, line))
    }
    const req: SolveRequest = { nodes, edges, fluid: FLUID, ambientC: 20, mode: 'steady' }
    const { r, rows, max, worst } = nets(req)
    console.log(`[man-autoline] status=${r.status}  ${rows}\n           maxImbalance=${max.toExponential(3)} at "${worst}"`)
  })

  it('off zone_valve — shut line flow + dir', () => {
    const SHUT_K = 1e7
    const req: SolveRequest = {
      nodes: [
        { id: 's', role: 'source', params: { ratedKw: 8, maxSupplyC: 50, h0Kpa: 45, qMaxM3h: 2 } },
        { id: 'zv', role: 'passive', params: { kKpa: SHUT_K } }, // off zone valve rewrite
        { id: 'e', role: 'emitter', params: { ratedKw: 3, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
      ],
      edges: [
        pipe('a', 's', 'sup', 'zv', 'in'),
        pipe('b', 'zv', 'out', 'e', 'sup'),
        pipe('c', 'e', 'ret', 's', 'ret', 'return'),
      ],
      fluid: FLUID, ambientC: 20, mode: 'steady',
    }
    const r = solve(req)
    for (const id of ['a', 'b', 'c']) {
      const er = r.edges[id]
      console.log(`[offzv] edge ${id}: flowM3h=${er.flowM3h.toExponential(4)} dir=${er.dir}  (readout ${(er.flowM3h).toFixed(2)} m³/h, ${(er.flowM3h * 1000 / 60).toFixed(1)} L/min)`)
    }
    console.log(`[offzv] global flowM3h=${r.global.flowM3h.toExponential(4)}`)
  })

  it('on zone_valve — same loop, valve open (kKpa=0.5)', () => {
    const req: SolveRequest = {
      nodes: [
        { id: 's', role: 'source', params: { ratedKw: 8, maxSupplyC: 50, h0Kpa: 45, qMaxM3h: 2 } },
        { id: 'zv', role: 'passive', params: { kKpa: 0.5 } },
        { id: 'e', role: 'emitter', params: { ratedKw: 3, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
      ],
      edges: [
        pipe('a', 's', 'sup', 'zv', 'in'),
        pipe('b', 'zv', 'out', 'e', 'sup'),
        pipe('c', 'e', 'ret', 's', 'ret', 'return'),
      ],
      fluid: FLUID, ambientC: 20, mode: 'steady',
    }
    const r = solve(req)
    for (const id of ['a', 'b', 'c']) {
      const er = r.edges[id]
      console.log(`[onzv] edge ${id}: flowM3h=${er.flowM3h.toFixed(4)} dir=${er.dir}`)
    }
  })
})

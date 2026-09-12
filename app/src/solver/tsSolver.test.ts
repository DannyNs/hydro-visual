// Unit tests for the TypeScript reference solver (tsSolver.ts).
//
// These exercise REAL converged solver behaviour — the requests are built in
// code with the same shape store/factory.ts::graphToSolveRequest produces
// (roles + flat numeric params; port-to-port edges with a `line`). The numeric
// expectations below were taken from the actual converged output of this solver
// and cross-checked against the Rust/WASM engine (see parity.test.ts), so they
// assert physics, not arbitrary constants.

import { describe, it, expect } from 'vitest'
import { solve } from './tsSolver'
import { makeRequest, node, edge, nodeNetFlows } from './testHelpers'

describe('tsSolver — heat-pump → radiator loop (a)', () => {
  // A single air-source heat pump with its BUILT-IN circulator (params include
  // h0Kpa/qMaxM3h so `source` drives its own ret→sup branch) feeds one radiator
  // and returns. Closed two-pipe loop, exactly one pump.
  const edges = [
    edge('e1', 'hp', 'sup', 'rad', 'sup', 'supply', 5, 22),
    edge('e2', 'rad', 'ret', 'hp', 'ret', 'return', 5, 22),
  ]
  const request = makeRequest(
    [
      node('hp', 'source', {
        ratedKw: 12,
        maxSupplyC: 52,
        sourceC: 7,
        copRated: 4.2,
        h0Kpa: 50,
        qMaxM3h: 2.6,
      }),
      node('rad', 'emitter', {
        ratedKw: 4,
        ratedExcessC: 50,
        roomC: 20,
        exponent: 1.3,
      }),
    ],
    edges,
    20,
  )
  const res = solve(request)

  it('converges with positive circulating flow', () => {
    expect(res.status).toBe('converged')
    expect(res.global.flowM3h).toBeGreaterThan(0.5)
  })

  it('warms supply up to the heat-pump max-supply cap (≈ maxSupplyC)', () => {
    // The heat pump is output-limited and the rad load is small, so the supply
    // pins to the maxSupplyC ceiling (52 °C).
    expect(res.global.supplyC).toBeCloseTo(52, 1)
    const rad = res.nodes.rad
    expect(rad.supplyC).toBeCloseTo(52, 1)
  })

  it('radiator return is cooler than the supply (it sheds heat to the room)', () => {
    const rad = res.nodes.rad
    expect(rad.supplyC).toBeDefined()
    expect(rad.returnC).toBeDefined()
    expect(rad.returnC as number).toBeLessThan(rad.supplyC as number)
    // global return mirrors the rad return and sits above room temp.
    expect(res.global.returnC).toBeLessThan(res.global.supplyC)
    expect(res.global.returnC).toBeGreaterThan(20)
  })

  it('per-node MASS CONSERVATION: every non-reference node sums to ≈ 0', () => {
    // Reference (slack) node = owner of port 0. The `source` node creates its
    // `ret` port first, so `hp:ret` is port 0 and `hp` carries the slack.
    const net = nodeNetFlows(res, edges)
    for (const [id, flow] of net) {
      if (id === 'hp') continue // hydraulic reference node
      expect(Math.abs(flow), `node ${id} net flow ${flow}`).toBeLessThan(0.01)
    }
  })
})

describe('tsSolver — graph with NO pump (c)', () => {
  it('returns an empty / zero-flow result', () => {
    // A bare `source` WITHOUT h0Kpa has no built-in circulator, and there is no
    // separate pump node, so nothing drives the loop.
    const request = makeRequest(
      [
        node('src', 'source', { ratedKw: 10, maxSupplyC: 60 }),
        node('rad', 'emitter', { ratedKw: 10, ratedExcessC: 50 }),
      ],
      [
        edge('e1', 'src', 'sup', 'rad', 'sup', 'supply', 5, 22),
        edge('e2', 'rad', 'ret', 'src', 'ret', 'return', 5, 22),
      ],
      20,
    )
    const res = solve(request)
    expect(res.status).toBe('empty')
    expect(res.global.flowM3h).toBe(0)
    // empty solve emits no edge results at all.
    expect(Object.keys(res.edges)).toHaveLength(0)
  })
})

describe('tsSolver — manifold feeding two radiators (d)', () => {
  // Heat pump → manifold (supply rail / return rail kept separate) → two radiator
  // circuits → back. The manifold's twin-star body forbids an internal supply→
  // return short-circuit, so the hot supply MUST travel out through both circuits.
  // Ambient is set deliberately low (27 °C) to prove the loop reaches the source's
  // real warm supply, not ambient.
  const edges = [
    edge('e1', 'hp', 'sup', 'man', 'sup_in', 'supply', 4, 28),
    edge('e2', 'man', 'ret_out', 'hp', 'ret', 'return', 4, 28),
    edge('c0s', 'man', 'sup0', 'rad0', 'sup', 'supply', 4, 16),
    edge('c0r', 'rad0', 'ret', 'man', 'ret0', 'return', 4, 16),
    edge('c1s', 'man', 'sup1', 'rad1', 'sup', 'supply', 4, 16),
    edge('c1r', 'rad1', 'ret', 'man', 'ret1', 'return', 4, 16),
  ]
  const request = makeRequest(
    [
      node('hp', 'source', { ratedKw: 12, maxSupplyC: 52, sourceC: 7, h0Kpa: 50, qMaxM3h: 2.6 }),
      node('man', 'manifold', { circuits: 2 }),
      node('rad0', 'emitter', { ratedKw: 2, ratedExcessC: 50, roomC: 20, exponent: 1.3 }),
      node('rad1', 'emitter', { ratedKw: 2, ratedExcessC: 50, roomC: 20, exponent: 1.3 }),
    ],
    edges,
    27, // low-ish ambient: warm supply must clearly exceed this
  )
  const res = solve(request)

  it('reaches WARM supply at the source max-supply, not ambient', () => {
    expect(res.status).toBe('converged')
    // supply pins to the source ceiling (52 °C), well above the 27 °C ambient.
    expect(res.global.supplyC).toBeCloseTo(52, 1)
    expect(res.global.supplyC).toBeGreaterThan(40)
    expect(res.nodes.man.supplyC as number).toBeGreaterThan(40)
  })

  it('both circuits carry real flow (no short-circuit through the manifold body)', () => {
    const c0 = res.edges['c0s']?.flowM3h ?? 0
    const c1 = res.edges['c1s']?.flowM3h ?? 0
    expect(c0).toBeGreaterThan(0.1)
    expect(c1).toBeGreaterThan(0.1)
    // symmetric circuits split the feed roughly evenly.
    expect(c0).toBeCloseTo(c1, 1)
    // and each radiator actually delivers heat.
    expect(res.nodes.rad0.heatKw ?? 0).toBeGreaterThan(0)
    expect(res.nodes.rad1.heatKw ?? 0).toBeGreaterThan(0)
  })

  it('per-node MASS CONSERVATION across the manifold network', () => {
    const net = nodeNetFlows(res, edges)
    for (const [id, flow] of net) {
      if (id === 'hp') continue // hydraulic reference (owns port 0 = hp:ret)
      expect(Math.abs(flow), `node ${id} net flow ${flow}`).toBeLessThan(0.01)
    }
  })
})

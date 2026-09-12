import { makeNode, makeEdge, syncPipeLengths, type RFNode, type RFEdge } from './factory'

// "Efficient Hybrid (HP-led)": the most efficient way to run a heat pump + gas
// boiler together. The heat pump does ALL space heating through its OWN buffer
// (every kWh at COP ~3 displaces gas); the buffer gives the HP run-time, defrost
// capacity and anti-cycling, and decouples it from the load pumps. The gas boiler
// does ONLY domestic hot water — direct, on demand, OFF the store (no standing
// loss). The two heating circuits are split off the buffer by BALANCING VALVES
// (the flow-distribution job a low-loss header would do), so there is no LLH and
// no mixing dilution. The two sources never fight: the buffer decouples the HP and
// the gas/DHW loop is independent.
//   • Heat pump → buffer → underfloor (mixing, ~35 °C) + radiators (direct, ~48 °C)
//   • Gas boiler → DHW cylinder (direct)
//
// Topology rules (see [[hydro-visual-app]]): every closed loop has exactly ONE
// pump, no two pumps share a port; the buffer is 4-pipe-per-zone so it stratifies
// (supply ports l0/l1 + r0/r1 = hot top, return ports l2/l3 + r2/r3 = cool bottom,
// split by pipe `line`). Balancing valves are inline resistances on each heating
// circuit's primary draw.
export function buildSeed(): { nodes: RFNode[]; edges: RFEdge[] } {
  const N = (
    kind: Parameters<typeof makeNode>[0],
    x: number,
    y: number,
    id: string,
    over?: Record<string, number>,
  ) => makeNode(kind, x, y, over, id)

  const nodes: RFNode[] = [
    // ---- heat pump + its buffer (does all space heating) ----
    N('heat_pump', 40, 120, 'hp', { ratedKw: 12, maxSupplyC: 52, sourceC: 7, copRated: 4.2, h0Kpa: 45, qMaxM3h: 2.6 }),
    N('dirt_separator', 250, 150, 'dirt'),
    N('buffer_tank', 440, 170, 'buf', { volumeL: 200, entriesPerSide: 4 }),
    // ---- radiator circuit: balancing valve → direct group (~48 °C) ----
    N('balancing_valve', 660, 70, 'balRad', { kKpa: 1.5 }),
    N('direct_group', 790, 60, 'dg', { qMaxM3h: 1.2 }),
    N('radiator', 1020, 20, 'rad1', { ratedKw: 4, ratedExcessC: 45 }),
    N('radiator', 1020, 140, 'rad2', { ratedKw: 3, ratedExcessC: 45 }),
    // ---- underfloor circuit: balancing valve → mixing group (~35 °C) ----
    N('balancing_valve', 660, 280, 'balUfh', { kKpa: 2 }),
    N('mixing_group', 790, 280, 'mg', { qMaxM3h: 1.4, targetSupplyC: 35 }),
    N('ufh_manifold', 1000, 280, 'ufm', { circuits: 2 }),
    N('underfloor', 1210, 240, 'uf1', { ratedKw: 5, ratedExcessC: 12 }),
    N('underfloor', 1210, 360, 'uf2', { ratedKw: 4, ratedExcessC: 12 }),
    // ---- gas boiler → DHW only (on demand, off the store) ----
    N('gas_boiler', 40, 480, 'boiler', { ratedKw: 18, maxSupplyC: 60, h0Kpa: 35, qMaxM3h: 1.4 }),
    N('fill_valve', 250, 480, 'fill', { setBar: 1.5 }),
    N('dhw_cylinder', 470, 470, 'dhw', { volumeL: 200, setpointC: 50, standbyKw: 4 }),
    // ---- safety / pressurisation ----
    N('air_vent', 420, 70, 'air'),
    N('expansion_vessel', 300, 300, 'exp'),
    N('pressure_relief', 420, 320, 'relief'),
  ]

  const pri = 28
  const sec = 22
  const mic = 16

  const edges: RFEdge[] = [
    // heat pump charge loop: HP -> dirt -> buffer top (l0); buffer bottom (l2) -> HP
    makeEdge('hp', 'sup', 'dirt', 'in', 'supply', 4, pri),
    makeEdge('dirt', 'out', 'buf', 'l0', 'supply', 4, pri),
    makeEdge('buf', 'l2', 'hp', 'ret', 'return', 6, pri),
    // radiators: buffer top (r0) -> balancing valve -> direct group; group return -> buffer bottom (r2)
    makeEdge('buf', 'r0', 'balRad', 'in', 'supply', 4, sec),
    makeEdge('balRad', 'out', 'dg', 'pri_in', 'supply', 3, sec),
    makeEdge('dg', 'pri_out', 'buf', 'r2', 'return', 4, sec),
    makeEdge('dg', 'sec_out', 'rad1', 'sup', 'supply', 5, sec),
    makeEdge('rad1', 'ret', 'dg', 'sec_in', 'return', 6, sec),
    makeEdge('dg', 'sec_out', 'rad2', 'sup', 'supply', 5, sec),
    makeEdge('rad2', 'ret', 'dg', 'sec_in', 'return', 6, sec),
    // underfloor: buffer top (r1) -> balancing valve -> mixing group; group return -> buffer bottom (r3)
    makeEdge('buf', 'r1', 'balUfh', 'in', 'supply', 4, sec),
    makeEdge('balUfh', 'out', 'mg', 'pri_in', 'supply', 3, sec),
    makeEdge('mg', 'pri_out', 'buf', 'r3', 'return', 4, sec),
    makeEdge('mg', 'sec_out', 'ufm', 'sup_in', 'supply', 5, sec),
    makeEdge('ufm', 'ret_out', 'mg', 'sec_in', 'return', 5, sec),
    makeEdge('ufm', 'sup0', 'uf1', 'sup', 'supply', 5, mic),
    makeEdge('uf1', 'ret', 'ufm', 'ret0', 'return', 6, mic),
    makeEdge('ufm', 'sup1', 'uf2', 'sup', 'supply', 5, mic),
    makeEdge('uf2', 'ret', 'ufm', 'ret1', 'return', 6, mic),
    // gas boiler -> DHW cylinder -> fill valve -> boiler (independent loop, off the store)
    makeEdge('boiler', 'sup', 'dhw', 'sup', 'supply', 5, sec),
    makeEdge('dhw', 'ret', 'fill', 'in', 'return', 4, sec),
    makeEdge('fill', 'out', 'boiler', 'ret', 'return', 2, sec),
    // safety taps (dead legs): air vent on the hot top, expansion + relief on the cool bottom
    makeEdge('air', 'tap', 'buf', 'l1', 'supply', 2, mic),
    makeEdge('exp', 'tap', 'buf', 'l3', 'return', 2, mic),
    makeEdge('relief', 'tap', 'buf', 'l3', 'return', 2, mic),
  ]

  // pipe lengths follow the drawn layout (makeEdge length args are placeholders)
  syncPipeLengths(nodes, edges)
  return { nodes, edges }
}

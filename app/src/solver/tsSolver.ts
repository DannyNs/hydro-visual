// TypeScript reference solver — mirrors the Rust/WASM physics so the app is
// fully functional even before the wasm engine loads (and a correctness oracle
// for it). Steady-state hydraulic (linear-theory nodal iteration) + thermal
// (component-sweep energy balance).

import type { SolveRequest, SolveResult, SolveNode } from './contract'
import { EMPTY_RESULT } from './contract'
import type { EdgeResult, NodeResult } from '../model/types'

const F_DARCY = 0.022

interface Branch {
  a: number // port-node index
  b: number
  k: number // resistance coefficient: dP = k * Q*|Q|  (Q in m^3/s)
  pumpH0: number // shutoff head [Pa], 0 if not a pump
  pumpQmax: number // [m^3/s]
  q: number // solved flow a->b [m^3/s]
  edgeId?: string // set for external pipe branches
  comp?: string // set for internal component branches (owning node id)
  check?: boolean // one-way (check valve): forward is a->b, reverse is blocked
}

// Effective resistance coefficient. A check valve passes forward flow (a->b)
// at its normal k but slams its resistance up when the current iterate runs
// backward, driving reverse flow toward zero (a one-way valve).
function effK(br: Branch): number {
  return br.check && br.q < 0 ? br.k * 1e7 : br.k
}

function pipeK(lengthM: number, diameterMm: number, rho: number): number {
  const Dm = Math.max(diameterMm, 5) / 1000
  const A = (Math.PI * Dm * Dm) / 4
  const L = Math.max(lengthM, 0.1)
  return (F_DARCY * (L / Dm) * 0.5 * rho) / (A * A)
}

// Minor loss given as a kPa drop at 1 m^3/h reference flow.
function minorK(kKpa: number): number {
  const qref = 1 / 3600 // m^3/s
  return (kKpa * 1000) / (qref * qref)
}

// Sealed-system GAUGE pressure [kPa] = cold-fill setpoint + thermal-expansion
// rise. As the loop heats above the ~15 C fill temperature the water expands and
// the expansion vessel takes it up, lifting the gauge (~+0.3-0.4 bar cold->hot for
// a typically-sized vessel); a larger vessel softens the swing, a smaller/absent
// one stiffens it. This is a STATIC quantity, deliberately independent of the
// circulator's differential head (reported separately as headKpa) — a running
// pump barely moves the gauge, but a working heat source heating the water does.
const T_FILL_C = 15
function staticPressureKpa(req: SolveRequest, meanTempC: number): number {
  // treat non-positive values as "absent" so TS and the Rust engine agree
  const fillKpa = req.pressure && req.pressure.fillKpa > 0 ? req.pressure.fillKpa : 120
  const vesselL = req.pressure && req.pressure.vesselL > 0 ? req.pressure.vesselL : 12
  const dT = Math.max(0, meanTempC - T_FILL_C)
  const vesselFactor = Math.max(0.5, Math.min(2, 12 / Math.max(vesselL, 4)))
  return round1(fillKpa + 0.9 * dT * vesselFactor)
}

export function solve(req: SolveRequest): SolveResult {
  const t0 = nowMs()
  try {
    return solveInner(req, t0)
  } catch (err) {
    return {
      ...EMPTY_RESULT,
      status: 'error',
      elapsedMs: nowMs() - t0,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function solveInner(req: SolveRequest, t0: number): SolveResult {
  const { nodes, edges } = req
  const rho = req.fluid.rhoKgM3 || 997
  const cp = req.fluid.cpJkgK || 4186
  const ambient = req.ambientC ?? 20

  if (nodes.length === 0) return { ...EMPTY_RESULT, elapsedMs: nowMs() - t0 }

  // ---- index ports ----
  const portIndex = new Map<string, number>()
  const portName: string[] = []
  const portOwner: string[] = []
  const ensurePort = (nodeId: string, portId: string): number => {
    const key = `${nodeId}:${portId}`
    let idx = portIndex.get(key)
    if (idx === undefined) {
      idx = portName.length
      portIndex.set(key, idx)
      portName.push(key)
      portOwner.push(nodeId)
    }
    return idx
  }

  const branches: Branch[] = []

  // ports actually used by each node, derived from the edges — lets junction /
  // tank stars and passive bodies connect whatever ports an instance has
  // (configurable tappings, fittings, …) with no hard-coded per-role list.
  const nodePortIds = new Map<string, string[]>()
  const addPort = (nodeId: string, portId: string) => {
    let arr = nodePortIds.get(nodeId)
    if (!arr) {
      arr = []
      nodePortIds.set(nodeId, arr)
    }
    if (!arr.includes(portId)) arr.push(portId)
  }
  for (const e of edges) {
    addPort(e.from, e.fromPort)
    addPort(e.to, e.toPort)
  }
  // line (supply=hot/top, return=cool/bottom) of the pipe at each port — used to
  // stratify tanks: supply ports are the top, return ports the bottom.
  const portLine = new Map<string, 'supply' | 'return'>()
  for (const e of edges) {
    const ln: 'supply' | 'return' = e.line === 'return' ? 'return' : 'supply'
    portLine.set(`${e.from}:${e.fromPort}`, ln)
    portLine.set(`${e.to}:${e.toPort}`, ln)
  }

  // ---- internal component branches ----
  for (const n of nodes) {
    const pr = n.params || {}
    const k = (kk: number) => Math.max(kk, 1)
    switch (n.role) {
      case 'pump': {
        const a = ensurePort(n.id, 'in')
        const b = ensurePort(n.id, 'out')
        const h0 = (pr.h0Kpa ?? 40) * 1000
        const qmaxSI = Math.max(pr.qMaxM3h ?? 3, 0.05) / 3600
        branches.push({
          a,
          b,
          // constant head h0 with branch resistance sized so the drop equals h0
          // exactly at qMax: a real falling pump characteristic that bounds flow
          // to [0, qMax] and stays numerically stable.
          k: h0 / (qmaxSI * qmaxSI),
          pumpH0: h0,
          pumpQmax: qmaxSI,
          q: qmaxSI * 0.5,
          comp: n.id,
        })
        break
      }
      case 'group': {
        // 4-port pump group: pump drives pri_in -> sec_out (supply through the
        // group); the return runs sec_in -> pri_out.
        const pin = ensurePort(n.id, 'pri_in')
        const pout = ensurePort(n.id, 'pri_out')
        const sout = ensurePort(n.id, 'sec_out')
        const sin = ensurePort(n.id, 'sec_in')
        const h0 = (pr.h0Kpa ?? 50) * 1000
        const qmaxSI = Math.max(pr.qMaxM3h ?? 3, 0.05) / 3600
        branches.push({
          a: pin,
          b: sout,
          k: h0 / (qmaxSI * qmaxSI),
          pumpH0: h0,
          pumpQmax: qmaxSI,
          q: qmaxSI * 0.5,
          comp: n.id,
        })
        branches.push({
          a: sin,
          b: pout,
          k: k(minorK(0.6)),
          pumpH0: 0,
          pumpQmax: 0,
          q: 0.0001,
          comp: n.id,
        })
        break
      }
      case 'source': {
        const a = ensurePort(n.id, 'ret')
        const b = ensurePort(n.id, 'sup')
        if (pr.h0Kpa !== undefined) {
          // built-in circulator: the source drives its own loop (ret -> sup)
          const h0 = pr.h0Kpa * 1000
          const qmaxSI = Math.max(pr.qMaxM3h ?? 2, 0.05) / 3600
          branches.push({
            a,
            b,
            k: h0 / (qmaxSI * qmaxSI),
            pumpH0: h0,
            pumpQmax: qmaxSI,
            q: qmaxSI * 0.5,
            comp: n.id,
          })
        } else {
          // no built-in pump (e.g. solar) — needs an external circulator
          branches.push({
            a,
            b,
            k: pipeK(2, 26, rho),
            pumpH0: 0,
            pumpQmax: 0,
            q: 0.0001,
            comp: n.id,
          })
        }
        break
      }
      case 'emitter': {
        const a = ensurePort(n.id, 'sup')
        const b = ensurePort(n.id, 'ret')
        branches.push({
          a,
          b,
          k: pipeK(10, 14, rho),
          pumpH0: 0,
          pumpQmax: 0,
          q: 0.0001,
          comp: n.id,
        })
        break
      }
      case 'valve': {
        const hot = ensurePort(n.id, 'hot')
        const cold = ensurePort(n.id, 'cold')
        const mix = ensurePort(n.id, 'mix')
        branches.push({
          a: hot,
          b: mix,
          k: k(minorK(2)),
          pumpH0: 0,
          pumpQmax: 0,
          q: 0.0001,
          comp: n.id,
        })
        branches.push({
          a: cold,
          b: mix,
          k: k(minorK(2)),
          pumpH0: 0,
          pumpQmax: 0,
          q: 0.0001,
          comp: n.id,
        })
        break
      }
      case 'tank':
      case 'junction': {
        // star: connect every connected port to the first with small resistance
        const ports = nodePortIds.get(n.id) ?? []
        if (ports.length >= 2) {
          const center = ensurePort(n.id, ports[0])
          for (let i = 1; i < ports.length; i++) {
            const pi = ensurePort(n.id, ports[i])
            branches.push({
              a: center,
              b: pi,
              k: k(minorK(pr.kKpa ?? 0.4)),
              pumpH0: 0,
              pumpQmax: 0,
              q: 0.0001,
              comp: n.id,
            })
          }
        }
        break
      }
      case 'manifold': {
        // TWO separate stars — a supply rail and a return rail — so the hot
        // supply can't short-circuit to the return inside the body; flow must
        // travel out through the circuits and back. Ports split by pipe line.
        const ports = nodePortIds.get(n.id) ?? []
        const rail = (side: 'supply' | 'return') => {
          const g = ports.filter((pid) => (portLine.get(`${n.id}:${pid}`) ?? 'supply') === side)
          if (g.length < 2) return
          const center = ensurePort(n.id, g[0])
          for (let i = 1; i < g.length; i++) {
            branches.push({
              a: center,
              b: ensurePort(n.id, g[i]),
              k: k(minorK(pr.kKpa ?? 0.3)),
              pumpH0: 0,
              pumpQmax: 0,
              q: 0.0001,
              comp: n.id,
            })
          }
        }
        rail('supply')
        rail('return')
        break
      }
      case 'check': {
        // one-way valve: a resistive in->out branch that only passes forward
        const a = ensurePort(n.id, 'in')
        const b = ensurePort(n.id, 'out')
        branches.push({
          a,
          b,
          k: k(minorK(pr.kKpa ?? 0.3)),
          pumpH0: 0,
          pumpQmax: 0,
          q: 0.0001,
          comp: n.id,
          check: true,
        })
        break
      }
      case 'passive': {
        const ports = nodePortIds.get(n.id) ?? []
        if (ports.length >= 2) {
          const a = ensurePort(n.id, ports[0])
          const b = ensurePort(n.id, ports[1])
          branches.push({
            a,
            b,
            k: k(minorK(pr.kKpa ?? 0.4)),
            pumpH0: 0,
            pumpQmax: 0,
            q: 0.0001,
            comp: n.id,
          })
        } else if (ports.length === 1) {
          ensurePort(n.id, ports[0]) // dead-leg tap
        }
        break
      }
    }
  }

  // ---- external pipe branches ----
  for (const e of edges) {
    const a = ensurePort(e.from, e.fromPort)
    const b = ensurePort(e.to, e.toPort)
    branches.push({
      a,
      b,
      k: pipeK(e.lengthM, e.diameterMm, rho),
      pumpH0: 0,
      pumpQmax: 0,
      q: 0.0001,
      edgeId: e.id,
    })
  }

  const N = portName.length
  const hasPump = branches.some((b) => b.pumpH0 > 0)
  if (N === 0 || branches.length === 0 || !hasPump) {
    // No flow driver (e.g. every pump/source switched off). The loop stops, but a
    // sealed system does NOT depressurise — the gauge still holds its cold static
    // pressure. Report that; only flow/head/heat go to zero.
    return {
      ...EMPTY_RESULT,
      elapsedMs: nowMs() - t0,
      global: { ...EMPTY_RESULT.global, pressureKpa: staticPressureKpa(req, ambient) },
    }
  }

  // ---- hydraulic: linear-theory iteration ----
  // Each branch is linearised as R = k·|q| (+ constant pump head H); the nodal
  // (graph-Laplacian) system A·p = rhs then enforces continuity at every
  // non-pinned port. We iterate R with under-relaxation for stability, then take
  // ONE final un-relaxed flow pass from the converged pressures: the relaxed
  // iterate lags and leaves a few-percent mass imbalance (which piles up on the
  // pinned ports), whereas q = (pa−pb+H)/R derived directly from the Laplacian
  // solution conserves mass exactly at every non-pinned port.
  let hydIters = 0
  const QFLOOR = 1e-5
  const branchH = (br: (typeof branches)[number]) => (br.pumpH0 > 0 ? br.pumpH0 : 0)
  // The nodal Laplacian is singular on every connected component (zero row-sum),
  // so each component needs exactly one pinned port to be solvable. Pin the
  // lowest-index port of EACH component — this keeps port 0 pinned as before, and
  // also grounds any disconnected dead leg / isolated tap without a leak term.
  // With no leak anywhere, A·p = rhs is exact continuity at every non-pinned port,
  // so mass is conserved exactly in every component (the old blanket 1e-12 leak
  // stole ~leak·p_i from each live node and broke the balance).
  const pinned: boolean[] = new Array(N).fill(false)
  {
    const adj: number[][] = Array.from({ length: N }, () => [])
    for (const br of branches) {
      adj[br.a].push(br.b)
      adj[br.b].push(br.a)
    }
    const seen = new Array(N).fill(false)
    for (let s = 0; s < N; s++) {
      if (seen[s]) continue
      // BFS this component, tracking its lowest-index port as the pin
      let minIdx = s
      const stack = [s]
      seen[s] = true
      while (stack.length) {
        const i = stack.pop() as number
        if (i < minIdx) minIdx = i
        for (const j of adj[i])
          if (!seen[j]) {
            seen[j] = true
            stack.push(j)
          }
      }
      pinned[minIdx] = true
    }
  }
  let p = new Array(N).fill(0)
  // conductance captured at A-build time each iteration; the final pass must use
  // THESE (the values that actually built the solved matrix), not a recompute from
  // the post-update br.q — otherwise q_final no longer satisfies continuity.
  const gFinal = new Array(branches.length).fill(0)
  for (let it = 0; it < 400; it++) {
    hydIters = it + 1
    const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0))
    const rhs = new Array(N).fill(0)
    for (let bi = 0; bi < branches.length; bi++) {
      const br = branches[bi]
      const R = effK(br) * Math.max(Math.abs(br.q), QFLOOR)
      const g = 1 / R
      const H = branchH(br)
      A[br.a][br.a] += g
      A[br.a][br.b] -= g
      A[br.b][br.b] += g
      A[br.b][br.a] -= g
      rhs[br.a] -= H / R
      rhs[br.b] += H / R
      gFinal[bi] = g
    }
    // pin one port per connected component (no leak — see note above); this also
    // pins the reference port 0, which is its component's lowest index
    for (let i = 0; i < N; i++)
      if (pinned[i]) {
        A[i].fill(0)
        A[i][i] = 1
        rhs[i] = 0
      }

    p = gaussSolve(A, rhs)
    let maxDq = 0
    for (const br of branches) {
      const R = effK(br) * Math.max(Math.abs(br.q), QFLOOR)
      const qNew = (p[br.a] - p[br.b] + branchH(br)) / R
      maxDq = Math.max(maxDq, Math.abs(qNew - br.q))
      br.q = br.q + 0.7 * (qNew - br.q) // under-relax for stability
    }
    if (maxDq < 1e-9) break
  }
  // final continuity-exact flows from the converged pressures, using the SAME
  // conductances that built the solved matrix (gFinal). Recomputing R from the
  // post-update br.q would desync q from A·p=rhs and break mass balance at every
  // non-slack node. Guard against a singular/degenerate solve producing NaN — TS
  // is the last-resort engine.
  for (let bi = 0; bi < branches.length; bi++) {
    const br = branches[bi]
    const q = gFinal[bi] * (p[br.a] - p[br.b] + branchH(br))
    br.q = Number.isFinite(q) ? q : 0
  }

  // ---- thermal: component-sweep energy balance ----
  // port temperatures; init ambient
  const portTemp = new Array(N).fill(ambient)
  // neighbor map via external pipes: for a port, the other-end port + branch
  interface Link {
    other: number
    q: number // |flow| m^3/s through the pipe
    fromHere: boolean // true if fluid leaves this port (into the pipe)
  }
  const pipeLinks: Map<number, Link[]> = new Map()
  for (const br of branches) {
    if (!br.edgeId) continue
    const mdotQ = Math.abs(br.q)
    const aLeaves = br.q > 0 // a->b
    addLink(pipeLinks, br.a, { other: br.b, q: mdotQ, fromHere: aLeaves })
    addLink(pipeLinks, br.b, { other: br.a, q: mdotQ, fromHere: !aLeaves })
  }

  // node outlet temp store
  const nodeOut: Map<string, number> = new Map()
  for (const n of nodes) nodeOut.set(n.id, ambient)

  // single source of truth captured during the sweep, used for all results
  const info = new Map<string, { tIn: number; tOut: number; mdot: number }>()
  // pump-group state: distinct primary/secondary in/out temps
  const groupInfo = new Map<
    string,
    { tPriIn: number; tSecIn: number; tSecOut: number; tPriOut: number; mdot: number }
  >()
  // stratified-tank state: top (hot/supply side) and bottom (cool/return side)
  const tankInfo = new Map<string, { top: number; bot: number; mdot: number }>()
  // manifold state: supply-rail temp + return-rail temp (kept separate)
  const manInfo = new Map<string, { sup: number; ret: number }>()
  // mixed inflow temperature + mass arriving at one specific port
  const portInflow = (nodeId: string, portId: string): { temp: number; mass: number } => {
    const idx = portIndex.get(`${nodeId}:${portId}`)
    if (idx === undefined) return { temp: NaN, mass: 0 }
    const links = pipeLinks.get(idx)
    let m = 0
    let e = 0
    if (links)
      for (const lk of links)
        if (!lk.fromHere && lk.q > QFLOOR) {
          m += lk.q
          e += lk.q * portTemp[lk.other]
        }
    return { temp: m > QFLOOR ? e / m : NaN, mass: m }
  }
  const history: SolveResult['history'] = []
  let thermalIters = 0
  let lastResidual = 1

  for (let it = 0; it < 120; it++) {
    thermalIters = it + 1
    let maxDt = 0
    for (const n of nodes) {
      if (n.role === 'group') {
        // 4-port pump group: hot enters pri_in, the load is served from sec_out;
        // the load return enters sec_in and the cooled primary leaves pri_out.
        const pr = n.params || {}
        const pi = portInflow(n.id, 'pri_in')
        const si = portInflow(n.id, 'sec_in')
        const prev = groupInfo.get(n.id)
        const tPriIn = Number.isFinite(pi.temp) ? pi.temp : (prev?.tPriIn ?? ambient)
        const tSecIn = Number.isFinite(si.temp) ? si.temp : (prev?.tSecIn ?? ambient)
        const mdot = Math.max(pi.mass, si.mass) * rho
        let tSecOut: number
        let tPriOut: number
        if (pr.targetSupplyC !== undefined) {
          // mixing: blend down to the target, energy taken from the primary
          tSecOut = Math.max(tSecIn, Math.min(tPriIn, pr.targetSupplyC))
          tPriOut = tPriIn - (tSecOut - tSecIn)
        } else {
          // direct: pass the hot through; the load return becomes the primary return
          tSecOut = tPriIn
          tPriOut = tSecIn
        }
        maxDt = Math.max(maxDt, Math.abs(tSecOut - (prev?.tSecOut ?? ambient)))
        const soIdx = portIndex.get(`${n.id}:sec_out`)
        const poIdx = portIndex.get(`${n.id}:pri_out`)
        if (soIdx !== undefined) portTemp[soIdx] = tSecOut
        if (poIdx !== undefined) portTemp[poIdx] = tPriOut
        nodeOut.set(n.id, tSecOut)
        groupInfo.set(n.id, { tPriIn, tSecIn, tSecOut, tPriOut, mdot })
        continue
      }
      if (n.role === 'tank' && n.params?.setpointC === undefined) {
        // energy-balanced 2-zone stratified buffer: hot charge enters the top
        // (supply-side inflow), cool load return enters the bottom (return-side
        // inflow); loads draw the top, the source draws the bottom. When charge
        // flow exceeds load flow the surplus hot overflows downward (and vice
        // versa), which conserves energy exactly.
        const tankPorts = nodePortIds.get(n.id) ?? []
        let chargeM = 0
        let chargeE = 0
        let retInM = 0
        let retInE = 0
        for (const pid of tankPorts) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portLine.get(`${n.id}:${pid}`) ?? 'supply'
          const links = pipeLinks.get(idx)
          if (!links) continue
          for (const lk of links) {
            if (lk.fromHere || lk.q <= QFLOOR) continue // inflows only
            if (side === 'supply') {
              chargeM += lk.q
              chargeE += lk.q * portTemp[lk.other]
            } else {
              retInM += lk.q
              retInE += lk.q * portTemp[lk.other]
            }
          }
        }
        const prevT = tankInfo.get(n.id)
        const chargeT = chargeM > QFLOOR ? chargeE / chargeM : (prevT?.top ?? ambient)
        const retT = retInM > QFLOOR ? retInE / retInM : (prevT?.bot ?? ambient)
        const fs = Math.max(chargeM, 1e-9)
        const fl = Math.max(retInM, 1e-9)
        let top: number
        let bot: number
        if (fs >= fl) {
          top = chargeT
          bot = (fl * retT + (fs - fl) * top) / fs
        } else {
          bot = retT
          top = (fs * chargeT + (fl - fs) * bot) / fl
        }
        for (const pid of tankPorts) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portLine.get(`${n.id}:${pid}`) ?? 'supply'
          portTemp[idx] = side === 'supply' ? top : bot
        }
        maxDt = Math.max(
          maxDt,
          Math.abs(top - (prevT?.top ?? ambient)),
          Math.abs(bot - (prevT?.bot ?? ambient)),
        )
        nodeOut.set(n.id, top)
        tankInfo.set(n.id, { top, bot, mdot: (chargeM + retInM) * rho })
        continue
      }
      if (n.role === 'manifold') {
        // supply rail carries the supply-side inflow temp, return rail the
        // return-side inflow mix — the two rails do NOT mix with each other.
        const mPorts = nodePortIds.get(n.id) ?? []
        let supM = 0
        let supE = 0
        let retM = 0
        let retE = 0
        for (const pid of mPorts) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portLine.get(`${n.id}:${pid}`) ?? 'supply'
          const links = pipeLinks.get(idx)
          if (!links) continue
          for (const lk of links) {
            if (lk.fromHere || lk.q <= QFLOOR) continue // inflows only
            if (side === 'supply') {
              supM += lk.q
              supE += lk.q * portTemp[lk.other]
            } else {
              retM += lk.q
              retE += lk.q * portTemp[lk.other]
            }
          }
        }
        const prevM = manInfo.get(n.id)
        const supT = supM > QFLOOR ? supE / supM : (prevM?.sup ?? ambient)
        const retT = retM > QFLOOR ? retE / retM : (prevM?.ret ?? ambient)
        for (const pid of mPorts) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portLine.get(`${n.id}:${pid}`) ?? 'supply'
          portTemp[idx] = side === 'supply' ? supT : retT
        }
        // track BOTH rails for convergence — the return rail can still be
        // climbing while the supply rail is steady; missing it lets the sweep
        // declare convergence prematurely and freeze the loop cold.
        maxDt = Math.max(
          maxDt,
          Math.abs(supT - (prevM?.sup ?? ambient)),
          Math.abs(retT - (prevM?.ret ?? ambient)),
        )
        nodeOut.set(n.id, supT)
        manInfo.set(n.id, { sup: supT, ret: retT })
        continue
      }
      const ports = nodePortIds.get(n.id) ?? []
      // compute mixed inlet temp from inflow ports
      let inMass = 0
      let inEnergy = 0
      for (const pid of ports) {
        const idx = portIndex.get(`${n.id}:${pid}`)
        if (idx === undefined) continue
        const links = pipeLinks.get(idx)
        if (!links) continue
        for (const lk of links) {
          if (!lk.fromHere && lk.q > QFLOOR) {
            // fluid flows from neighbor port into this port
            inMass += lk.q
            inEnergy += lk.q * portTemp[lk.other]
          }
        }
      }
      const tIn = inMass > QFLOOR ? inEnergy / inMass : (nodeOut.get(n.id) ?? ambient)
      const mdot = inMass * rho // kg/s
      const tOut = applyComponent(n, tIn, mdot, cp, ambient)
      const prev = nodeOut.get(n.id) ?? ambient
      maxDt = Math.max(maxDt, Math.abs(tOut - prev))
      nodeOut.set(n.id, tOut)
      info.set(n.id, { tIn, tOut, mdot })
      // write all outflow ports (and tank inner) to tOut
      for (const pid of ports) {
        const idx = portIndex.get(`${n.id}:${pid}`)
        if (idx === undefined) continue
        portTemp[idx] = tOut
      }
    }
    lastResidual = maxDt
    const g = computeGlobal(nodes, info, rho, cp)
    history.push({ iter: it + 1, supplyC: g.supplyC, returnC: g.returnC, heatKw: g.heatKw })
    if (maxDt < 1e-4) break
  }

  // ---- assemble results ----
  const edgeOut: Record<string, EdgeResult> = {}
  for (const br of branches) {
    if (!br.edgeId) continue
    // temperature in the pipe = upstream port temp
    const upstream = br.q >= 0 ? br.a : br.b
    const tempC = portTemp[upstream]
    // A shut device (SHUT_K) still leaks a sub-QFLOOR trickle through its huge
    // resistance; report it as exactly zero so the readout shows "0.00" and no
    // animation, not 1e-4 m³/h.
    const flowM3h = Math.abs(br.q) < QFLOOR ? 0 : Math.abs(br.q) * 3600
    edgeOut[br.edgeId] = {
      flowM3h,
      tempC,
      line: tempC >= midTemp(portTemp) ? 'supply' : 'return',
      // flow direction along the drawn edge (source->target): +1 forward, -1 reverse
      dir: Math.abs(br.q) < QFLOOR ? 0 : br.q >= 0 ? 1 : -1,
    }
  }

  const nodeOutMap: Record<string, NodeResult> = {}
  for (const n of nodes) {
    if (n.role === 'group') {
      const gi = groupInfo.get(n.id)
      if (gi) {
        const res: NodeResult = {
          heatKw: round1((gi.mdot * cp * (gi.tSecOut - gi.tSecIn)) / 1000),
          supplyC: round1(gi.tSecOut),
          returnC: round1(gi.tSecIn),
        }
        if (n.params?.targetSupplyC !== undefined) {
          const span = Math.max(gi.tPriIn - gi.tSecIn, 1)
          res.valvePct = Math.round(
            Math.min(100, Math.max(0, ((gi.tSecOut - gi.tSecIn) / span) * 100)),
          )
        }
        nodeOutMap[n.id] = res
      } else nodeOutMap[n.id] = {}
    } else if (n.role === 'tank' && n.params?.setpointC === undefined) {
      const ti = tankInfo.get(n.id)
      if (ti) {
        const hot = ti.top
        const cold = ti.bot
        nodeOutMap[n.id] = {
          supplyC: round1(hot),
          returnC: round1(cold),
          strat: Array.from({ length: 6 }, (_, i) => round1(hot - (i / 5) * (hot - cold))),
        }
      } else nodeOutMap[n.id] = {}
    } else if (n.role === 'manifold') {
      const mi = manInfo.get(n.id)
      nodeOutMap[n.id] = mi ? { supplyC: round1(mi.sup), returnC: round1(mi.ret) } : {}
    } else {
      nodeOutMap[n.id] = buildNodeResult(n, info.get(n.id), rho, cp, ambient)
    }
  }

  const g = computeGlobal(nodes, info, rho, cp)
  const totalHead = Math.max(
    0,
    ...branches
      .filter((b) => b.pumpH0 > 0)
      .map((b) => {
        const ratio = Math.min(Math.abs(b.q) / b.pumpQmax, 1)
        return (b.pumpH0 * (1 - ratio * ratio)) / 1000
      }),
  )

  const status: SolveResult['status'] = g.flowM3h > 1e-3 ? 'converged' : 'empty'

  return {
    status,
    iterations: hydIters + thermalIters,
    residual: lastResidual,
    elapsedMs: nowMs() - t0,
    global: {
      flowM3h: g.flowM3h,
      headKpa: totalHead,
      pressureKpa: staticPressureKpa(req, (g.supplyC + g.returnC) / 2),
      supplyC: g.supplyC,
      returnC: g.returnC,
      deltaC: Math.max(0, g.supplyC - g.returnC),
      heatKw: g.heatKw,
      cop: g.cop,
    },
    edges: edgeOut,
    nodes: nodeOutMap,
    history,
  }
}

// ---- component thermal rules ----

function applyComponent(
  n: SolveNode,
  tIn: number,
  mdot: number,
  cp: number,
  ambient: number,
): number {
  const pr = n.params || {}
  const eps = 1e-6
  switch (n.role) {
    case 'source': {
      const maxSupply = pr.maxSupplyC ?? 75
      if (mdot < eps) return Math.min(maxSupply, tIn)
      const rise = ((pr.ratedKw ?? 24) * 1000) / (mdot * cp)
      return Math.min(maxSupply, tIn + rise)
    }
    case 'emitter': {
      const room = pr.roomC ?? 20
      const n_exp = pr.exponent ?? 1.3
      const excess = Math.max(pr.ratedExcessC ?? 50, 1)
      const UA = ((pr.ratedKw ?? 2) * 1000) / Math.pow(excess, n_exp)
      if (mdot < eps) return tIn
      // solve mdot*cp*(tIn - tOut) = UA*((tIn+tOut)/2 - room)^n  (bisect)
      let lo = room
      let hi = tIn
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        const tmean = (tIn + mid) / 2
        const qEmit = UA * Math.pow(Math.max(tmean - room, 0), n_exp)
        const qFluid = mdot * cp * (tIn - mid)
        if (qFluid > qEmit) lo = mid
        else hi = mid
      }
      return (lo + hi) / 2
    }
    case 'valve': {
      // blend toward target (clamped to available range handled by mixing already)
      const target = pr.targetC ?? 40
      return Math.max(ambient, Math.min(tIn, target > tIn ? tIn : target))
    }
    case 'tank': {
      // DHW cylinder draws a standby load; buffer is a pass-through mixer
      if (pr.setpointC !== undefined) {
        const draw = (pr.standbyKw ?? 0) * 1000
        if (mdot < eps) return tIn
        return tIn - draw / (mdot * cp)
      }
      return tIn
    }
    case 'junction':
    case 'pump':
    case 'passive':
    default:
      return tIn
  }
}

// ---- result helpers (read the stored per-node sweep data) ----

type NodeInfo = { tIn: number; tOut: number; mdot: number }

function buildNodeResult(
  n: SolveNode,
  inf: NodeInfo | undefined,
  rho: number,
  cp: number,
  ambient: number,
): NodeResult {
  const res: NodeResult = {}
  if (!inf) return res
  const { tIn, tOut, mdot } = inf
  const pr = n.params || {}
  if (n.role === 'source') {
    res.heatKw = round1((mdot * cp * (tOut - tIn)) / 1000)
    res.supplyC = round1(tOut)
    res.returnC = round1(tIn)
    if (pr.copRated !== undefined) {
      res.cop = round2(
        clampCop((pr.copRated ?? 4.2) - 0.06 * (tOut - 35) + 0.07 * ((pr.sourceC ?? 7) - 7)),
      )
    }
  } else if (n.role === 'emitter') {
    res.heatKw = round1((mdot * cp * (tIn - tOut)) / 1000)
    res.supplyC = round1(tIn)
    res.returnC = round1(tOut)
  } else if (n.role === 'tank') {
    // only DHW cylinders reach here — buffers (setpointC undefined) are fully
    // handled by the stratified tankInfo path in the sweep result assembly
    res.supplyC = round1(tOut)
    res.returnC = round1(tIn)
    res.heatKw = -round1(pr.standbyKw ?? 0)
  } else if (n.role === 'valve') {
    res.supplyC = round1(tOut)
    const range = Math.max(tIn - ambient, 1)
    res.valvePct = Math.round(Math.min(100, Math.max(0, ((tOut - ambient) / range) * 100)))
  } else if (n.role === 'pump' || n.role === 'junction') {
    res.supplyC = round1(tOut)
  }
  return res
}

function computeGlobal(
  nodes: SolveNode[],
  info: Map<string, NodeInfo>,
  rho: number,
  cp: number,
): { flowM3h: number; supplyC: number; returnC: number; heatKw: number; cop: number | null } {
  let supMass = 0
  let supEnergy = 0
  let retEnergy = 0
  let heat = 0
  let copSum = 0
  let copMass = 0
  for (const n of nodes) {
    if (n.role !== 'source') continue
    const inf = info.get(n.id)
    if (!inf || inf.mdot < 1e-6) continue
    const delivered = (inf.mdot * cp * (inf.tOut - inf.tIn)) / 1000
    supMass += inf.mdot
    supEnergy += inf.mdot * inf.tOut
    retEnergy += inf.mdot * inf.tIn
    heat += Math.max(delivered, 0)
    const pr = n.params || {}
    if (pr.copRated !== undefined) {
      const cop = clampCop(
        (pr.copRated ?? 4.2) - 0.06 * (inf.tOut - 35) + 0.07 * ((pr.sourceC ?? 7) - 7),
      )
      copSum += cop * inf.mdot
      copMass += inf.mdot
    }
  }
  const flow = supMass > 1e-6 ? (supMass / rho) * 3600 : 0
  return {
    flowM3h: round2(flow),
    supplyC: supMass > 1e-6 ? round1(supEnergy / supMass) : 0,
    returnC: supMass > 1e-6 ? round1(retEnergy / supMass) : 0,
    heatKw: round1(heat),
    cop: copMass > 1e-6 ? round2(copSum / copMass) : null,
  }
}

// ---- small utilities ----

function addLink<T>(map: Map<number, T[]>, key: number, val: T): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

function midTemp(temps: number[]): number {
  if (temps.length === 0) return 40
  let lo = Infinity
  let hi = -Infinity
  for (const t of temps) {
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  return (lo + hi) / 2
}

function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    // partial pivot
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col] || 1e-12
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

// Heat-pump COP bounded to a physical band: a real ASHP neither runs below ~1.5
// nor exceeds ~6 (the catalog itself caps rated COP at 6). The linear model has
// no inherent ceiling, so warm-source/high-rated inputs could otherwise report a
// non-physical COP > 6.
function clampCop(cop: number): number {
  return Math.max(1.5, Math.min(6.5, cop))
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
function round2(x: number): number {
  return Math.round(x * 100) / 100
}
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0
}

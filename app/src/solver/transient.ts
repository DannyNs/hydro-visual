// Transient (time-stepped) thermal solver for the hydronic simulator.
//
// Plain TypeScript, runs in a Web Worker (no DOM / React). It REUSES the
// steady-state hydraulic network model from tsSolver.ts exactly (identical
// F_DARCY / pipeK / minorK / pump model / role wiring), solving the hydraulics
// ONCE to get signed branch flows. It then evolves a cold-start charge-up over
// simulated time: every tank temperature is a state variable, everything else
// is quasi-steady and recomputed by an algebraic component sweep each step.
//
// Output is a list of playback frames (node + edge + global results per frame),
// mirroring the result fragments in ../model/types and ../contract.

import type {
  SolveRequest,
  SolveNode,
  TransientResult,
  TransientFrame,
  GlobalResult,
} from './contract'
import type { EdgeResult, NodeResult } from '../model/types'

const F_DARCY = 0.022

// ---------------------------------------------------------------------------
// Hydraulic network (replicated from tsSolver, identical constants / K values)
// ---------------------------------------------------------------------------

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

// Check valves pass forward (a->b) but slam their resistance up against reverse
// flow, driving it toward zero.
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

// ---------------------------------------------------------------------------
// Per-edge metadata used by the thermal model (line side for tank ports).
// ---------------------------------------------------------------------------

interface PortMeta {
  // line of the edge connected to this port ('supply' | 'return' | 'auto')
  line: 'supply' | 'return' | 'auto'
}

// One physical pipe seen from a port: the other-end port + |flow| + whether
// fluid leaves this port into the pipe.
interface Link {
  other: number
  q: number // |flow| m^3/s through the pipe
  fromHere: boolean // true if fluid leaves this port (into the pipe)
  line: 'supply' | 'return' | 'auto'
}

interface TankState {
  id: string
  stratified: boolean // buffer (true) vs DHW well-mixed cylinder (false)
  layers: number // 1 for DHW
  temps: number[] // top -> bottom (length === layers)
  cLayer: number // J/K per layer (buffer) or whole node (DHW)
  // connected ports classified by side; populated once during build
  supplyPorts: number[] // port indices whose connected edge is supply-side
  returnPorts: number[] // port indices whose connected edge is return-side
  setpointC?: number // DHW only
  standbyKw: number // DHW only
}

interface Built {
  branches: Branch[]
  N: number
  portIndex: Map<string, number>
  portMeta: PortMeta[]
  nodePortIds: Map<string, string[]>
  pipeLinks: Map<number, Link[]>
  tanks: TankState[]
  hasPump: boolean
}

// ---------------------------------------------------------------------------
// Build the network + solve hydraulics once.
// ---------------------------------------------------------------------------

function buildNetwork(req: SolveRequest): Built {
  const { nodes, edges } = req
  const rho = req.fluid.rhoKgM3 || 997
  const cp = req.fluid.cpJkgK || 4186
  const ambient = req.ambientC ?? 20
  const layersOpt = Math.max(2, Math.round(req.transient?.layers ?? 10))

  const portIndex = new Map<string, number>()
  const portName: string[] = []
  const portMeta: PortMeta[] = []
  const ensurePort = (nodeId: string, portId: string): number => {
    const key = `${nodeId}:${portId}`
    let idx = portIndex.get(key)
    if (idx === undefined) {
      idx = portName.length
      portIndex.set(key, idx)
      portName.push(key)
      portMeta.push({ line: 'auto' })
    }
    return idx
  }

  const branches: Branch[] = []

  // ports actually used by each node, derived from the edges (same as tsSolver)
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
  // pipe line per port (supply/return) — needed at branch-build time to split a
  // manifold into two rails (mirrors tsSolver's portLine).
  const portLine = new Map<string, 'supply' | 'return'>()
  for (const e of edges) {
    const ln: 'supply' | 'return' = e.line === 'return' ? 'return' : 'supply'
    portLine.set(`${e.from}:${e.fromPort}`, ln)
    portLine.set(`${e.to}:${e.toPort}`, ln)
  }

  // ---- internal component branches (mirror tsSolver exactly) ----
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
          k: h0 / (qmaxSI * qmaxSI),
          pumpH0: h0,
          pumpQmax: qmaxSI,
          q: qmaxSI * 0.5,
          comp: n.id,
        })
        break
      }
      case 'group': {
        // 4-port pump group: pump drives pri_in -> sec_out; return sec_in -> pri_out
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
        // two separate stars (supply rail + return rail) so flow can't
        // short-circuit supply->return inside the body (mirror tsSolver).
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

  // ---- external pipe branches + record port line side ----
  for (const e of edges) {
    const a = ensurePort(e.from, e.fromPort)
    const b = ensurePort(e.to, e.toPort)
    // a port adopts the line of any explicit (non-auto) edge attached to it
    if (e.line !== 'auto') {
      if (portMeta[a].line === 'auto') portMeta[a].line = e.line
      if (portMeta[b].line === 'auto') portMeta[b].line = e.line
    }
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

  // ---- hydraulic: linear-theory iteration (solve ONCE) ----
  if (N > 0 && branches.length > 0 && hasPump) {
    const QFLOOR = 1e-5
    // The nodal Laplacian is singular on every connected component (zero row-sum),
    // so each component needs exactly one pinned port to be solvable. Pin the
    // lowest-index port of EACH component — this keeps port 0 pinned as before, and
    // also grounds any disconnected dead leg / isolated tap without a leak term.
    // With no leak anywhere, A·p = rhs is exact continuity at every non-pinned port,
    // so mass is conserved exactly in every component (the old blanket 1e-9 leak
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
    for (let it = 0; it < 60; it++) {
      const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0))
      const rhs = new Array(N).fill(0)
      for (let bi = 0; bi < branches.length; bi++) {
        const br = branches[bi]
        const absQ = Math.max(Math.abs(br.q), QFLOOR)
        const R = effK(br) * absQ
        const g = 1 / R
        const H = br.pumpH0 > 0 ? br.pumpH0 : 0
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
        const absQ = Math.max(Math.abs(br.q), QFLOOR)
        const R = effK(br) * absQ
        const H = br.pumpH0 > 0 ? br.pumpH0 : 0
        const qNew = (p[br.a] - p[br.b] + H) / R
        maxDq = Math.max(maxDq, Math.abs(qNew - br.q))
        br.q = br.q + 0.7 * (qNew - br.q)
      }
      if (maxDq < 1e-7) break
    }
    // final continuity-exact flows from the converged pressures, using the SAME
    // conductances that built the solved matrix (gFinal). Recomputing R from the
    // post-update br.q would desync q from A·p=rhs and break mass balance at every
    // non-slack node.
    for (let bi = 0; bi < branches.length; bi++) {
      const br = branches[bi]
      const H = br.pumpH0 > 0 ? br.pumpH0 : 0
      const q = gFinal[bi] * (p[br.a] - p[br.b] + H)
      br.q = Number.isFinite(q) ? q : 0
    }
  }

  // ---- pipe links for thermal advection ----
  const QFLOOR = 1e-5
  const pipeLinks: Map<number, Link[]> = new Map()
  for (const br of branches) {
    if (!br.edgeId) continue
    const mdotQ = Math.abs(br.q)
    const aLeaves = br.q > 0 // a->b
    const line = edgeLineOf(br, portMeta)
    addLink(pipeLinks, br.a, { other: br.b, q: mdotQ, fromHere: aLeaves, line })
    addLink(pipeLinks, br.b, { other: br.a, q: mdotQ, fromHere: !aLeaves, line })
  }

  // ---- tank state objects ----
  const tanks: TankState[] = []
  for (const n of nodes) {
    if (n.role !== 'tank') continue
    const pr = n.params || {}
    const stratified = pr.setpointC === undefined
    const volumeL = Math.max(pr.volumeL ?? 200, 1)
    const ports = nodePortIds.get(n.id) ?? []

    // classify each connected port by the side of its connected edge. If the
    // edge line is 'auto' we infer later at runtime from temperatures; here we
    // seed using the explicit line, falling back to flow-direction heuristic
    // (a port from which fluid leaves the tank carrying heat is a supply tap).
    const supplyPorts: number[] = []
    const returnPorts: number[] = []
    for (const pid of ports) {
      const idx = portIndex.get(`${n.id}:${pid}`)
      if (idx === undefined) continue
      const side = portSideOf(idx, pipeLinks, portMeta)
      if (side === 'return') returnPorts.push(idx)
      else supplyPorts.push(idx) // default supply when unknown
    }

    if (stratified) {
      const layers = layersOpt
      const cLayer = (volumeL / layers / 1000) * rho * cp
      tanks.push({
        id: n.id,
        stratified: true,
        layers,
        temps: new Array(layers).fill(ambient),
        cLayer,
        supplyPorts,
        returnPorts,
        standbyKw: pr.standbyKw ?? 0,
      })
    } else {
      const cLayer = (volumeL / 1000) * rho * cp
      tanks.push({
        id: n.id,
        stratified: false,
        layers: 1,
        temps: [ambient],
        cLayer,
        supplyPorts,
        returnPorts,
        setpointC: pr.setpointC,
        standbyKw: pr.standbyKw ?? 0,
      })
    }
  }

  // Resume from a warm state: seed tank layer temps from the request (an edit
  // mid-charge re-runs from the current temperatures instead of cold ambient).
  // Clamp the index so a layer-count change still maps sensibly.
  const seed = req.transient?.initialTankTemps
  if (seed) {
    for (const tk of tanks) {
      const s = seed[tk.id]
      if (s && s.length) tk.temps = tk.temps.map((_, i) => s[Math.min(i, s.length - 1)])
    }
  }

  // collapse near-zero flows for cleaner thermal behavior (mirrors QFLOOR)
  for (const br of branches) if (Math.abs(br.q) < QFLOOR) br.q = 0

  return { branches, N, portIndex, portMeta, nodePortIds, pipeLinks, tanks, hasPump }
}

// Determine the line of the pipe a branch represents.
function edgeLineOf(br: Branch, portMeta: PortMeta[]): 'supply' | 'return' | 'auto' {
  const la = portMeta[br.a]?.line ?? 'auto'
  const lb = portMeta[br.b]?.line ?? 'auto'
  if (la !== 'auto') return la
  if (lb !== 'auto') return lb
  return 'auto'
}

// Classify a tank port by side: prefer the explicit edge line; else infer from
// flow direction (fluid leaving the tank => supply tap).
function portSideOf(
  idx: number,
  pipeLinks: Map<number, Link[]>,
  portMeta: PortMeta[],
): 'supply' | 'return' {
  if (portMeta[idx]?.line === 'return') return 'return'
  if (portMeta[idx]?.line === 'supply') return 'supply'
  const links = pipeLinks.get(idx)
  if (links) {
    for (const lk of links) {
      if (lk.line === 'return') return 'return'
      if (lk.line === 'supply') return 'supply'
    }
    // heuristic: if fluid mostly leaves this port, it is a supply (outlet) tap
    let out = 0
    let inn = 0
    for (const lk of links) {
      if (lk.fromHere) out += lk.q
      else inn += lk.q
    }
    if (inn > out) return 'return'
  }
  return 'supply'
}

// ---------------------------------------------------------------------------
// Quasi-steady thermal sweep (algebraic, with current tank temps as boundary).
// Returns port temperatures + per-node {tIn,tOut,mdot}.
// ---------------------------------------------------------------------------

type NodeInfo = { tIn: number; tOut: number; mdot: number }

function thermalSweep(
  req: SolveRequest,
  net: Built,
): { portTemp: number[]; info: Map<string, NodeInfo> } {
  const { nodes } = req
  const rho = req.fluid.rhoKgM3 || 997
  const cp = req.fluid.cpJkgK || 4186
  const ambient = req.ambientC ?? 20
  const QFLOOR = 1e-5
  const { N, portIndex, nodePortIds, pipeLinks, tanks, portMeta } = net

  const tankById = new Map<string, TankState>()
  for (const t of tanks) tankById.set(t.id, t)

  const portTemp = new Array(N).fill(ambient)
  const nodeOut: Map<string, number> = new Map()
  for (const n of nodes) nodeOut.set(n.id, ambient)
  const info = new Map<string, NodeInfo>()
  // manifold supply-rail / return-rail temps (kept separate, no mixing)
  const manInfo = new Map<string, { sup: number; ret: number }>()

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

  // pin tank outlet ports to their layer temps up-front so other nodes pick up
  // the tank boundary on the very first iteration.
  applyTankBoundaries(tanks, portTemp)

  for (let it = 0; it < 40; it++) {
    let maxDt = 0
    for (const n of nodes) {
      const ports = nodePortIds.get(n.id) ?? []

      if (n.role === 'group') {
        // 4-port pump group: distinct primary/secondary temps (see tsSolver)
        const pr = n.params || {}
        const pi = portInflow(n.id, 'pri_in')
        const si = portInflow(n.id, 'sec_in')
        const tPriIn = Number.isFinite(pi.temp) ? pi.temp : ambient
        const tSecIn = Number.isFinite(si.temp) ? si.temp : ambient
        const mdot = Math.max(pi.mass, si.mass) * rho
        let tSecOut: number
        let tPriOut: number
        if (pr.targetSupplyC !== undefined) {
          tSecOut = Math.max(tSecIn, Math.min(tPriIn, pr.targetSupplyC))
          tPriOut = tPriIn - (tSecOut - tSecIn)
        } else {
          tSecOut = tPriIn
          tPriOut = tSecIn
        }
        const soIdx = portIndex.get(`${n.id}:sec_out`)
        const poIdx = portIndex.get(`${n.id}:pri_out`)
        if (soIdx !== undefined) portTemp[soIdx] = clampT(tSecOut, ambient)
        if (poIdx !== undefined) portTemp[poIdx] = clampT(tPriOut, ambient)
        maxDt = Math.max(maxDt, Math.abs(tSecOut - (nodeOut.get(n.id) ?? ambient)))
        nodeOut.set(n.id, tSecOut)
        info.set(n.id, { tIn: tSecIn, tOut: tSecOut, mdot })
        continue
      }

      if (n.role === 'manifold') {
        // supply rail = supply-side inflow temp, return rail = return-side
        // inflow mix; the rails do NOT mix. Track BOTH for convergence.
        let supM = 0
        let supE = 0
        let retM = 0
        let retE = 0
        for (const pid of ports) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portSideOf(idx, pipeLinks, portMeta)
          const links = pipeLinks.get(idx)
          if (!links) continue
          for (const lk of links) {
            if (lk.fromHere || lk.q <= QFLOOR) continue
            if (side === 'return') {
              retM += lk.q
              retE += lk.q * portTemp[lk.other]
            } else {
              supM += lk.q
              supE += lk.q * portTemp[lk.other]
            }
          }
        }
        const prevM = manInfo.get(n.id)
        const supT = supM > QFLOOR ? supE / supM : (prevM?.sup ?? ambient)
        const retT = retM > QFLOOR ? retE / retM : (prevM?.ret ?? ambient)
        for (const pid of ports) {
          const idx = portIndex.get(`${n.id}:${pid}`)
          if (idx === undefined) continue
          const side = portSideOf(idx, pipeLinks, portMeta)
          portTemp[idx] = clampT(side === 'return' ? retT : supT, ambient)
        }
        maxDt = Math.max(
          maxDt,
          Math.abs(supT - (prevM?.sup ?? ambient)),
          Math.abs(retT - (prevM?.ret ?? ambient)),
        )
        nodeOut.set(n.id, supT)
        info.set(n.id, { tIn: retT, tOut: supT, mdot: (supM + retM) * rho })
        manInfo.set(n.id, { sup: supT, ret: retT })
        continue
      }

      // mixed inlet temp from inflow ports (fluid arriving via pipes)
      let inMass = 0
      let inEnergy = 0
      for (const pid of ports) {
        const idx = portIndex.get(`${n.id}:${pid}`)
        if (idx === undefined) continue
        const links = pipeLinks.get(idx)
        if (!links) continue
        for (const lk of links) {
          if (!lk.fromHere && lk.q > QFLOOR) {
            inMass += lk.q
            inEnergy += lk.q * portTemp[lk.other]
          }
        }
      }
      const tIn = inMass > QFLOOR ? inEnergy / inMass : (nodeOut.get(n.id) ?? ambient)
      const mdot = inMass * rho // kg/s

      if (n.role === 'tank') {
        // A tank does NOT mix; its outlet ports are fixed to layer temps. We
        // still record tIn/tOut for results, but writing ports is handled by
        // the boundary application below.
        const tank = tankById.get(n.id)
        const tOut = tank ? (tank.stratified ? tank.temps[0] : tank.temps[0]) : tIn
        info.set(n.id, { tIn, tOut, mdot })
        nodeOut.set(n.id, tOut)
        continue
      }

      const tOut = clampT(applyComponent(n, tIn, mdot, cp, ambient), ambient)
      const prev = nodeOut.get(n.id) ?? ambient
      maxDt = Math.max(maxDt, Math.abs(tOut - prev))
      nodeOut.set(n.id, tOut)
      info.set(n.id, { tIn, tOut, mdot })
      for (const pid of ports) {
        const idx = portIndex.get(`${n.id}:${pid}`)
        if (idx === undefined) continue
        portTemp[idx] = tOut
      }
    }
    // re-pin tank boundaries each iteration (their temps are fixed this step)
    applyTankBoundaries(tanks, portTemp)
    if (maxDt < 1e-4) break
  }

  return { portTemp, info }
}

// Fix every tank outlet port to a layer temperature: supply-side ports output
// the TOP layer, return-side ports output the BOTTOM layer (single temp for DHW).
function applyTankBoundaries(tanks: TankState[], portTemp: number[]): void {
  for (const t of tanks) {
    const top = t.temps[0]
    const bottom = t.temps[t.temps.length - 1]
    for (const idx of t.supplyPorts) portTemp[idx] = top
    for (const idx of t.returnPorts) portTemp[idx] = bottom
  }
}

// ---- component thermal rules (mirror tsSolver) ----
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
      const target = pr.targetC ?? 40
      return Math.max(ambient, Math.min(tIn, target > tIn ? tIn : target))
    }
    case 'junction':
    case 'pump':
    case 'passive':
    default:
      return tIn
  }
}

// ---------------------------------------------------------------------------
// Tank charging: compute dT/dt for each tank given the sweep result.
// ---------------------------------------------------------------------------

// Returns the per-layer temperature derivative [K/s] for one tank.
function tankDerivatives(
  t: TankState,
  net: Built,
  portTemp: number[],
  rho: number,
  cp: number,
): number[] {
  const QFLOOR = 1e-5
  const { pipeLinks } = net

  // Aggregate supply-side and return-side mass flows and their inflow temps.
  let supInMass = 0
  let supInEnergy = 0
  let supOutMass = 0
  let retInMass = 0
  let retInEnergy = 0
  let retOutMass = 0

  const accum = (ports: number[], isSupply: boolean) => {
    for (const idx of ports) {
      const links = pipeLinks.get(idx)
      if (!links) continue
      for (const lk of links) {
        if (lk.q <= QFLOOR) continue
        if (lk.fromHere) {
          // fluid leaves the tank through this port (a draw)
          if (isSupply) supOutMass += lk.q
          else retOutMass += lk.q
        } else {
          // fluid enters the tank
          const tInPipe = portTemp[lk.other]
          if (isSupply) {
            supInMass += lk.q
            supInEnergy += lk.q * tInPipe
          } else {
            retInMass += lk.q
            retInEnergy += lk.q * tInPipe
          }
        }
      }
    }
  }
  accum(t.supplyPorts, true)
  accum(t.returnPorts, false)

  // convert volumetric to mass [kg/s]
  const mSupIn = supInMass * rho
  const mSupOut = supOutMass * rho
  const mRetIn = retInMass * rho
  const mRetOut = retOutMass * rho
  const tSupIn = supInMass > QFLOOR ? supInEnergy / supInMass : t.temps[0]
  const tRetIn = retInMass > QFLOOR ? retInEnergy / retInMass : t.temps[t.temps.length - 1]

  // ---- DHW well-mixed cylinder ----
  if (!t.stratified) {
    const T = t.temps[0]
    // mixed inflow over BOTH sides feeds the single node
    const mIn = mSupIn + mRetIn
    const inEnergy = mSupIn * tSupIn + mRetIn * tRetIn
    const tInMix = mIn > 1e-9 ? inEnergy / mIn : T
    const standby = (t.standbyKw ?? 0) * 1000
    const dQ = mIn * cp * (tInMix - T) - standby
    const C = Math.max(t.cLayer, 1)
    return [dQ / C]
  }

  // ---- buffer: stratified top-down ----
  const L = t.temps
  const n = L.length
  const dL = new Array(n).fill(0)
  const C = Math.max(t.cLayer, 1)

  // Net throughflow that pushes the stratification column. Supply-in (hot)
  // enters the TOP and pushes fluid DOWN; return-in (cooler) enters the BOTTOM
  // and pushes fluid UP. The net downward inter-layer flow:
  const mDown = mSupIn // [kg/s] pushing down from the top
  const mUp = mRetIn // [kg/s] pushing up from the bottom

  // Boundary inflow enthalpy is injected by the advection loop below through
  // its i = 0 (fromAbove = tSupIn) and i = n-1 (fromBelow = tRetIn) special
  // cases — adding explicit boundary source terms here would double-count it.
  // Draws leave at the local layer temperature and need no extra term.

  // Inter-layer plug-flow advection (upwind, stable):
  //  - downward stream carries layer i-1 temp into layer i at rate mDown
  //  - upward stream carries layer i+1 temp into layer i at rate mUp
  for (let i = 0; i < n; i++) {
    if (mDown > 0) {
      const fromAbove = i > 0 ? L[i - 1] : tSupIn
      dL[i] += mDown * cp * (fromAbove - L[i]) // gain from above
    }
    if (mUp > 0) {
      const fromBelow = i < n - 1 ? L[i + 1] : tRetIn
      dL[i] += mUp * cp * (fromBelow - L[i]) // gain from below
    }
  }

  // Small conduction between adjacent layers (mild de-stratification).
  const kCond = 0.0008 * C // W/K-ish; scaled to layer capacitance for stability
  for (let i = 0; i < n; i++) {
    const above = i > 0 ? L[i - 1] : L[i]
    const below = i < n - 1 ? L[i + 1] : L[i]
    dL[i] += kCond * (above + below - 2 * L[i])
  }

  // standby loss for the buffer (usually 0) spread across all layers
  const standby = (t.standbyKw ?? 0) * 1000
  if (standby > 0) for (let i = 0; i < n; i++) dL[i] -= standby / n

  // mass-conservation sanity: ignore tiny residual imbalance (mDown vs mUp +
  // boundary draws) — the upwind scheme above is stable regardless.
  void mSupOut
  void mRetOut

  return dL.map((d) => d / C)
}

// ---------------------------------------------------------------------------
// Result assembly per frame.
// ---------------------------------------------------------------------------

function buildNodeResult(
  n: SolveNode,
  inf: NodeInfo | undefined,
  tank: TankState | undefined,
  rho: number,
  cp: number,
  ambient: number,
): NodeResult {
  const res: NodeResult = {}
  const pr = n.params || {}

  if (n.role === 'tank' && tank) {
    if (tank.stratified) {
      // buoyancy keeps the hottest water on top and coldest on the bottom, so
      // present the layers sorted (hot -> cold) rather than as a raw U-profile.
      const sorted = tank.temps.map((x) => round1(x)).sort((a, b) => b - a)
      res.strat = sorted
      res.supplyC = sorted[0]
      res.returnC = sorted[sorted.length - 1]
    } else {
      res.supplyC = round1(tank.temps[0])
      res.returnC = round1(inf ? inf.tIn : tank.temps[0])
      res.heatKw = -round1(tank.standbyKw ?? 0)
    }
    return res
  }

  if (!inf) return res
  const { tIn, tOut, mdot } = inf
  if (n.role === 'group') {
    // inf holds {tIn: sec return, tOut: sec supply, mdot}
    res.heatKw = round1((mdot * cp * (tOut - tIn)) / 1000)
    res.supplyC = round1(tOut)
    res.returnC = round1(tIn)
    return res
  }
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
  } else if (n.role === 'valve') {
    res.supplyC = round1(tOut)
    const range = Math.max(tIn - ambient, 1)
    res.valvePct = Math.round(Math.min(100, Math.max(0, ((tOut - ambient) / range) * 100)))
  } else if (n.role === 'manifold') {
    // inf holds {tIn: return rail, tOut: supply rail}
    res.supplyC = round1(tOut)
    res.returnC = round1(tIn)
  } else if (n.role === 'pump' || n.role === 'junction') {
    res.supplyC = round1(tOut)
  }
  return res
}

function computeGlobal(
  nodes: SolveNode[],
  info: Map<string, NodeInfo>,
  branches: Branch[],
  rho: number,
  cp: number,
): GlobalResult {
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
  const totalHead = Math.max(
    0,
    ...branches
      .filter((b) => b.pumpH0 > 0)
      .map((b) => {
        const ratio = Math.min(Math.abs(b.q) / Math.max(b.pumpQmax, 1e-9), 1)
        return (b.pumpH0 * (1 - ratio * ratio)) / 1000
      }),
  )
  const supplyC = supMass > 1e-6 ? supEnergy / supMass : 0
  const returnC = supMass > 1e-6 ? retEnergy / supMass : 0
  return {
    flowM3h: round2(flow),
    headKpa: round1(totalHead),
    pressureKpa: round1(totalHead + 100),
    supplyC: round1(supplyC),
    returnC: round1(returnC),
    deltaC: round1(Math.max(0, supplyC - returnC)),
    heatKw: round1(heat),
    cop: copMass > 1e-6 ? round2(copSum / copMass) : null,
  }
}

function buildFrame(req: SolveRequest, net: Built, t: number): TransientFrame {
  const rho = req.fluid.rhoKgM3 || 997
  const cp = req.fluid.cpJkgK || 4186
  const ambient = req.ambientC ?? 20
  const { portTemp, info } = thermalSweep(req, net)

  const tankById = new Map<string, TankState>()
  for (const tk of net.tanks) tankById.set(tk.id, tk)

  // edges
  const edgeOut: Record<string, EdgeResult> = {}
  const mid = midTemp(portTemp)
  for (const br of net.branches) {
    if (!br.edgeId) continue
    const upstream = br.q >= 0 ? br.a : br.b
    const tempC = portTemp[upstream]
    // A shut device (SHUT_K) still leaks a sub-QFLOOR trickle through its huge
    // resistance; report it as exactly zero so the readout shows "0.00" and no
    // animation, not 1e-4 m³/h.
    const QFLOOR = 1e-5
    const flowM3h = Math.abs(br.q) < QFLOOR ? 0 : Math.abs(br.q) * 3600
    const line = lineForEdge(br, net.portMeta, tempC, mid)
    const dir = br.q > 1e-9 ? 1 : br.q < -1e-9 ? -1 : 0
    edgeOut[br.edgeId] = { flowM3h: round2(flowM3h), tempC: round1(tempC), line, dir }
  }

  // nodes
  const nodeOutMap: Record<string, NodeResult> = {}
  for (const n of req.nodes) {
    nodeOutMap[n.id] = buildNodeResult(n, info.get(n.id), tankById.get(n.id), rho, cp, ambient)
  }

  const global = computeGlobal(req.nodes, info, net.branches, rho, cp)
  // Gauge pressure tracks the loop temperature (thermal expansion), not pump head.
  global.pressureKpa = staticPressureKpa(req, (global.supplyC + global.returnC) / 2)
  // Snapshot raw tank temps so an edit can resume the run from this warm state.
  const tankTemps: Record<string, number[]> = {}
  for (const tk of net.tanks) tankTemps[tk.id] = tk.temps.map(round1)
  return { t: Math.round(t), global, nodes: nodeOutMap, edges: edgeOut, tankTemps }
}

function lineForEdge(
  br: Branch,
  portMeta: PortMeta[],
  tempC: number,
  mid: number,
): 'supply' | 'return' {
  const explicit = edgeLineOf(br, portMeta)
  if (explicit === 'supply' || explicit === 'return') return explicit
  return tempC >= mid ? 'supply' : 'return'
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export function solveTransient(req: SolveRequest): TransientResult {
  const t0 = nowMs()
  const opts = req.transient
  const durationS = Math.max(1, opts?.durationS ?? 7200)
  const frameCount = Math.max(2, Math.round(opts?.frameCount ?? 90))

  try {
    const rho = req.fluid.rhoKgM3 || 997
    const cp = req.fluid.cpJkgK || 4186

    if (!req.nodes || req.nodes.length === 0) {
      return { status: 'empty', dtS: 0, durationS, elapsedMs: nowMs() - t0, frames: [] }
    }

    const net = buildNetwork(req)

    // no pump / no closed loop driving flow -> empty
    if (!net.hasPump || net.N === 0) {
      return { status: 'empty', dtS: 0, durationS, elapsedMs: nowMs() - t0, frames: [] }
    }
    // require at least some flow somewhere (a genuine pumped loop)
    const anyFlow = net.branches.some((b) => Math.abs(b.q) > 1e-5)
    if (!anyFlow) {
      return { status: 'empty', dtS: 0, durationS, elapsedMs: nowMs() - t0, frames: [] }
    }

    // ---- pick a stable explicit-Euler dt ----
    // dt = clamp(0.4 * min(C_layer / (max mdot * cp)), 1, 60) seconds.
    let minTau = Infinity
    {
      // a representative max mass flow per tank (drives the layer time constant)
      for (const tk of net.tanks) {
        const mdot = tankMaxMassFlow(tk, net, rho)
        const denom = Math.max(mdot * cp, 1e-6)
        minTau = Math.min(minTau, tk.cLayer / denom)
      }
    }
    if (!isFinite(minTau)) minTau = 60 // no tanks: nominal
    const dt = clamp(0.4 * minTau, 1, 60)

    const frames: TransientFrame[] = []

    // If there are no tanks at all, the system is instantly steady; emit >=2
    // frames of the same steady state.
    if (net.tanks.length === 0) {
      const f0 = buildFrame(req, net, 0)
      const f1 = buildFrame(req, net, durationS)
      return {
        status: 'ok',
        dtS: dt,
        durationS,
        elapsedMs: nowMs() - t0,
        frames: [f0, { ...f1 }],
      }
    }

    // ---- time-march, recording frames evenly spaced over the ACTUAL run ----
    // We don't know the actual end time up front (auto-stop on steady), so we
    // record every step into a buffer, then subsample to frameCount including
    // t=0 and the final steady frame.
    type Snap = { t: number; temps: number[][] } // tank temps per step
    const snaps: Snap[] = []
    const snapNow = (t: number) => {
      snaps.push({ t, temps: net.tanks.map((tk) => tk.temps.slice()) })
    }

    let t = 0
    snapNow(0)
    const maxSteps = Math.ceil(durationS / dt) + 2
    let steadyStreak = 0
    let steps = 0
    for (; steps < maxSteps; steps++) {
      // sweep to get boundary port temps for the current tank state
      const { portTemp } = thermalSweep(req, net)

      // compute derivatives and integrate explicit Euler
      let maxRate = 0
      const newTemps: number[][] = []
      for (const tk of net.tanks) {
        const dL = tankDerivatives(tk, net, portTemp, rho, cp)
        const next = tk.temps.map((T, i) => clampT(T + dL[i] * dt, req.ambientC ?? 20))
        newTemps.push(next)
        for (let i = 0; i < dL.length; i++) maxRate = Math.max(maxRate, Math.abs(dL[i]))
      }
      // commit
      net.tanks.forEach((tk, i) => {
        tk.temps = newTemps[i]
      })
      t += dt
      snapNow(t)

      // steady detection: max |dT/dt|*dt small for several consecutive steps
      if (maxRate * dt < 1e-3) {
        steadyStreak++
        if (steadyStreak >= 3) break
      } else {
        steadyStreak = 0
      }
      if (t >= durationS) break
    }

    const tEnd = t

    // ---- subsample snaps -> frameCount frames (always include first & last) ----
    const lastIdx = snaps.length - 1
    const idxSet = new Set<number>()
    const count = Math.min(frameCount, snaps.length)
    if (count <= 1) {
      idxSet.add(0)
    } else {
      for (let f = 0; f < count; f++) {
        const idx = Math.round((f / (count - 1)) * lastIdx)
        idxSet.add(idx)
      }
    }
    idxSet.add(0)
    idxSet.add(lastIdx)
    const sortedIdx = Array.from(idxSet).sort((p, q) => p - q)

    for (const si of sortedIdx) {
      const snap = snaps[si]
      // restore tank temps to this snapshot, then build the frame (sweep fills
      // node/edge temps at that instant).
      net.tanks.forEach((tk, i) => {
        tk.temps = snap.temps[i].slice()
      })
      frames.push(buildFrame(req, net, snap.t))
    }

    // guarantee >= 2 frames even if steady reached immediately
    if (frames.length < 2) {
      const only = frames[0] ?? buildFrame(req, net, 0)
      frames.length = 0
      frames.push({ ...only, t: 0 })
      frames.push({ ...only, t: Math.round(tEnd) || Math.round(durationS) })
    }

    return {
      status: 'ok',
      dtS: dt,
      durationS,
      elapsedMs: nowMs() - t0,
      frames,
    }
  } catch (err) {
    return {
      status: 'error',
      dtS: 0,
      durationS,
      elapsedMs: nowMs() - t0,
      frames: [],
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// Representative maximum mass flow [kg/s] passing through a tank, used for the
// layer time constant when picking dt.
function tankMaxMassFlow(t: TankState, net: Built, rho: number): number {
  const QFLOOR = 1e-5
  let q = 0
  const all = [...t.supplyPorts, ...t.returnPorts]
  for (const idx of all) {
    const links = net.pipeLinks.get(idx)
    if (!links) continue
    for (const lk of links) {
      if (lk.q > QFLOOR) q = Math.max(q, lk.q)
    }
  }
  return q * rho
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

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

function clampT(x: number, ambient: number): number {
  if (!isFinite(x)) return ambient
  const lo = ambient - 2
  const hi = 98
  return x < lo ? lo : x > hi ? hi : x
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

// Sealed-system GAUGE pressure [kPa] = cold-fill setpoint + thermal-expansion
// rise (water expands as it heats, the expansion vessel buffers it). Mirrors the
// steady tsSolver model; kept SEPARATE from pump differential head.
function staticPressureKpa(req: SolveRequest, meanTempC: number): number {
  // treat non-positive values as "absent" so TS and the Rust engine agree
  const fillKpa = req.pressure && req.pressure.fillKpa > 0 ? req.pressure.fillKpa : 120
  const vesselL = req.pressure && req.pressure.vesselL > 0 ? req.pressure.vesselL : 12
  const dT = Math.max(0, meanTempC - 15)
  const vesselFactor = Math.max(0.5, Math.min(2, 12 / Math.max(vesselL, 4)))
  return round1(fillKpa + 0.9 * dT * vesselFactor)
}

// Heat-pump COP bounded to a physical band (~1.5..6). Mirrors tsSolver.
function clampCop(cop: number): number {
  return Math.max(1.5, Math.min(6.5, cop))
}

function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
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

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
function round2(x: number): number {
  return Math.round(x * 100) / 100
}
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0
}

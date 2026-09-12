import type { Node, Edge } from '@xyflow/react'
import type { ComponentKind, CompNodeData, PipeEdgeData } from '../model/types'
import { CATALOG, defaultParams } from '../model/catalog'
import type { SolveRequest } from '../solver/contract'

export type RFNode = Node<CompNodeData>
export type RFEdge = Edge<PipeEdgeData>

let seq = 1
export function nextId(prefix = 'n'): string {
  return `${prefix}${seq++}`
}

// Advance the shared id counter past every numeric suffix found in `ids`, so ids
// minted later by makeNode/makeEdge can't collide with seeded, restored (from
// localStorage) or imported ids. A collision makes React Flow render two
// edges/nodes with the same React key and silently drop one — e.g. drawing a new
// pipe deletes an existing pipe (id `e1` reused). Call whenever the graph is
// (re)loaded or replaced wholesale; the counter only ever moves forward.
export function syncSeq(ids: Iterable<string>): void {
  let max = seq - 1
  for (const id of ids) {
    const m = /(\d+)$/.exec(id)
    if (m) {
      const n = Number(m[1])
      if (n > max) max = n
    }
  }
  seq = max + 1
}

export function makeNode(
  kind: ComponentKind,
  x: number,
  y: number,
  override?: Record<string, number>,
  id?: string,
): RFNode {
  const def = CATALOG[kind]
  return {
    id: id ?? nextId(kind[0]),
    type: 'component',
    position: { x, y },
    data: {
      kind,
      label: def.label,
      params: { ...defaultParams(kind), ...override },
    },
  }
}

export function makeEdge(
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
  line: PipeEdgeData['line'] = 'auto',
  lengthM = 4,
  diameterMm = 22,
  id?: string,
): RFEdge {
  return {
    id: id ?? `e${seq++}`,
    source,
    target,
    sourceHandle: sourcePort,
    targetHandle: targetPort,
    type: 'pipe',
    data: { line, lengthM, diameterMm },
  }
}

// ---- pipe length from the on-canvas drawing ----------------------------------
// A pipe's hydraulic length tracks the distance it is DRAWN on the schematic, so
// the diagram is to scale: spread two components apart and their pipe carries more
// resistance (less flow), exactly like real pipework. 50 px ≈ 1 m (a typical
// component gap of ~200 px → ~4 m, the old fixed default).
const M_PER_PX = 0.02
const MIN_LEN_M = 0.5
const MAX_LEN_M = 100

// Pixel position of one port on a node (its handle on the node's edge), so the
// measured length matches the drawn pipe (port-to-port), not just node centres.
function portPos(n: RFNode, portId: string | null | undefined): { x: number; y: number } {
  const def = CATALOG[n.data.kind]
  const size = def?.size ?? { w: 90, h: 90 }
  const ports = def?.dynamicPorts ? def.dynamicPorts(n.data.params) : (def?.ports ?? [])
  const p = ports.find((pt) => pt.id === portId)
  const off = p?.offset ?? 0.5
  const { x, y } = n.position
  switch (p?.side) {
    case 'left':
      return { x, y: y + off * size.h }
    case 'right':
      return { x: x + size.w, y: y + off * size.h }
    case 'top':
      return { x: x + off * size.w, y }
    case 'bottom':
      return { x: x + off * size.w, y: y + size.h }
    default:
      return { x: x + size.w / 2, y: y + size.h / 2 } // unknown → centre
  }
}

// Pipe length [m] from the drawn distance between two connected ports.
export function visualPipeLengthM(
  a: RFNode,
  aPort: string | null | undefined,
  b: RFNode,
  bPort: string | null | undefined,
): number {
  const pa = portPos(a, aPort)
  const pb = portPos(b, bPort)
  const px = Math.hypot(pb.x - pa.x, pb.y - pa.y)
  return Math.min(MAX_LEN_M, Math.max(MIN_LEN_M, Math.round(px * M_PER_PX * 10) / 10))
}

// Recompute every pipe's length from the current node positions (mutates
// edge.data.lengthM). Called after any change that moves nodes — connect, drag,
// auto-arrange, load — so length stays relative to the visual at all times.
// Pipes whose length the user typed by hand (lengthManual) are left alone.
export function syncPipeLengths(nodes: RFNode[], edges: RFEdge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    if (e.data?.lengthManual) continue
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (a && b && e.data) e.data.lengthM = visualPipeLengthM(a, e.sourceHandle, b, e.targetHandle)
  }
}

// Effective resistance of a shut device [kPa·h²/m⁶]. Must be high enough that
// even a strong pump elsewhere can't push a visible trickle through it: at 5e3
// an off zone valve still leaked ~0.1 m³/h (q≈√(Δp/k)); 1e7 drops that to a
// few thousandths of a m³/h — below the flow-animation threshold. Both engines
// honour kKpa (k_floor is a floor, not a cap), so this blocks in wasm and TS.
const SHUT_K = 1e7

// Body resistance of an OFF powered device [kPa·h²/m⁶]. A switched-off heat
// pump/boiler/pump has no pump head, but its body is just pipe-like: other
// pumps CAN drive a small parasitic flow through it (which is exactly why real
// systems isolate loops with zone/check valves). So an off device passes flow
// at roughly straight-pipe resistance — only closed and one-way valves shut.
const OFF_BODY_K = 0.4

// Map one UI node to a solver node, applying its on/off state. A switched-off
// powered device loses its pump head (and heat output) but still passes flow
// through its body at small resistance: it's rewritten as a passive element
// BEFORE the request reaches any engine — so on/off needs no engine change and
// works in steady, transient, wasm and TS alike. Only valves shut: an off zone
// valve is a closed valve (SHUT_K), and check valves always block reverse.
// group keeps its 4-port routing via a manifold (two rails) with the same small
// body resistance on both rails.
function solveNodeOf(n: RFNode): SolveRequest['nodes'][number] {
  // an unknown kind (corrupt import / newer schema) maps to an inert passive
  // element instead of crashing the request build
  const def = CATALOG[n.data.kind]
  if (!def) return { id: n.id, role: 'passive', params: {} }
  const role = def.role
  if (n.data.enabled === false) {
    if (role === 'group') return { id: n.id, role: 'manifold', params: { kKpa: OFF_BODY_K } }
    if (n.data.kind === 'zone_valve') return { id: n.id, role: 'passive', params: { kKpa: SHUT_K } }
    if (role === 'source' || role === 'pump')
      return { id: n.id, role: 'passive', params: { kKpa: OFF_BODY_K } }
  }
  return { id: n.id, role, params: n.data.params }
}

// Distil the sealed-system static-pressure inputs from the placed components.
// The cold-fill setpoint comes from a fill_valve (its setBar), defaulting to
// 1.2 bar when none is placed; the expansion-vessel volume (summed) buffers the
// thermal-expansion swing — a bigger vessel gives a gentler rise. These feed the
// solver's gauge-pressure model, which is kept separate from pump head.
function pressureConfig(nodes: RFNode[]): { fillKpa: number; vesselL: number } {
  const fill = nodes.find((n) => n.data.kind === 'fill_valve')
  const fillKpa = fill ? (fill.data.params.setBar ?? 1.5) * 100 : 120
  const vesselL = nodes
    .filter((n) => n.data.kind === 'expansion_vessel')
    .reduce((sum, n) => sum + (n.data.params.volumeL ?? 18), 0)
  return { fillKpa, vesselL: vesselL || 12 }
}

// UI graph -> solver contract. The catalog supplies each kind's solver role.
export function graphToSolveRequest(nodes: RFNode[], edges: RFEdge[], ambientC = 20): SolveRequest {
  return {
    pressure: pressureConfig(nodes),
    nodes: nodes.map(solveNodeOf),
    edges: edges
      .filter((e) => e.sourceHandle && e.targetHandle)
      .map((e) => ({
        id: e.id,
        from: e.source,
        fromPort: e.sourceHandle as string,
        to: e.target,
        toPort: e.targetHandle as string,
        line: e.data?.line ?? 'auto',
        lengthM: e.data?.lengthM ?? 4,
        diameterMm: e.data?.diameterMm ?? 22,
      })),
    fluid: { cpJkgK: 4186, rhoKgM3: 997 },
    ambientC,
    mode: 'steady',
  }
}

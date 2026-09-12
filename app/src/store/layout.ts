import dagre from '@dagrejs/dagre'
import { CATALOG } from '../model/catalog'
import type { RFNode, RFEdge } from './factory'

// Distinct-but-tidy layout presets the auto-arrange button cycles through, so the
// user can click repeatedly and keep whichever framing fits best. Each varies the
// flow direction, dagre ranking algorithm and spacing — every one is a clean
// layered layout, just a different shape. `align` (UL/UR/DL/DR) biases node
// alignment within a rank; `ranker` changes how ranks are assigned.
export const LAYOUT_VARIANTS = [
  { rankdir: 'LR', ranker: 'network-simplex', nodesep: 100, ranksep: 170 },
  { rankdir: 'TB', ranker: 'network-simplex', nodesep: 90, ranksep: 150 },
  { rankdir: 'LR', ranker: 'tight-tree', nodesep: 70, ranksep: 215 },
  { rankdir: 'LR', ranker: 'network-simplex', nodesep: 60, ranksep: 120, align: 'UL' },
  { rankdir: 'TB', ranker: 'tight-tree', nodesep: 135, ranksep: 130 },
  { rankdir: 'LR', ranker: 'longest-path', nodesep: 115, ranksep: 160 },
] as const

export const LAYOUT_VARIANT_COUNT = LAYOUT_VARIANTS.length

// Auto-arrange the nodes into a tidy layered layout. `variant` selects one of the
// presets above (wrapped), so successive auto-arrange clicks each produce a
// different arrangement. Heat sources lead along the supply flow (left/top),
// emitters trail; dagre handles rank assignment + crossing reduction. Returns new
// top-left positions keyed by node id (unconnected nodes are left where they are).
export function computeLayout(
  nodes: RFNode[],
  edges: RFEdge[],
  variant = 0,
): Record<string, { x: number; y: number }> {
  const n = LAYOUT_VARIANTS.length
  const v = LAYOUT_VARIANTS[((variant % n) + n) % n]
  const g = new dagre.graphlib.Graph()
  // generous spacing so nodes and their overflowing name/temperature labels never
  // crowd each other — nodesep is the gap WITHIN a rank, ranksep the gap BETWEEN
  // ranks (where the pipe temp/flow labels sit). Per-variant from the preset.
  const base = {
    rankdir: v.rankdir,
    ranker: v.ranker,
    nodesep: v.nodesep,
    ranksep: v.ranksep,
    marginx: 60,
    marginy: 60,
  }
  g.setGraph('align' in v && v.align ? { ...base, align: v.align } : base)
  g.setDefaultEdgeLabel(() => ({}))

  // only connected nodes take part — dagre would otherwise pile every stray
  // (degree-0) component at the start rank instead of leaving it where it is
  const connected = new Set<string>()
  for (const e of edges) {
    connected.add(e.source)
    connected.add(e.target)
  }
  for (const node of nodes) {
    if (!connected.has(node.id)) continue
    const size = CATALOG[node.data.kind]?.size ?? { w: 90, h: 90 }
    g.setNode(node.id, { width: size.w, height: size.h })
  }
  // Rank along the SUPPLY direction so heat sources lead and emitters trail, with
  // distribution (tanks/headers, pump groups, manifolds) in between. Return pipes
  // run the opposite way, so add them REVERSED — that way they reinforce the
  // source→load order instead of pulling loads back toward the source (and it
  // breaks the supply/return loop into a clean DAG for dagre). Direction-agnostic:
  // works for every rankdir (LR/TB/…).
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue
    if (e.data?.line === 'return') g.setEdge(e.target, e.source)
    else g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  const out: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) {
    const gn = g.node(node.id)
    if (!gn) continue
    // dagre reports node centres; React Flow positions are top-left corners
    out[node.id] = { x: Math.round(gn.x - gn.width / 2), y: Math.round(gn.y - gn.height / 2) }
  }
  return out
}

import type { RFNode, RFEdge } from './factory'
import { CATALOG } from '../model/catalog'

// Autosave the design to localStorage so a reload doesn't wipe the user's work.
// Only the topology is stored — solver results (node/edge `.result`) and React
// Flow's transient ui flags are recomputed/derived and are stripped on save.
const KEY = 'hydro-visual:graph:v1'

export interface PersistedGraph {
  nodes: RFNode[]
  edges: RFEdge[]
}

// Drop malformed entries from a restored/imported graph: nodes whose kind isn't
// in the catalog (corrupt file / newer schema) would crash the solver mapping
// and the connect handler, and an edge whose end node was dropped would dangle.
export function sanitizeGraph(g: PersistedGraph): PersistedGraph {
  const nodes = (g.nodes ?? []).filter(
    (n): n is RFNode =>
      !!n &&
      typeof n.id === 'string' &&
      !!n.position &&
      typeof n.data?.kind === 'string' &&
      CATALOG[n.data.kind] !== undefined,
  )
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (g.edges ?? []).filter(
    (e): e is RFEdge =>
      !!e && typeof e.id === 'string' && ids.has(e.source) && ids.has(e.target),
  )
  return { nodes, edges }
}

const DROP = new Set(['result', 'selected', 'dragging', 'resizing'])

export function saveGraph(graph: PersistedGraph): void {
  try {
    const json = JSON.stringify(graph, (k, v) => (DROP.has(k) ? undefined : v))
    localStorage.setItem(KEY, json)
  } catch {
    // storage full / unavailable / serialization issue — non-fatal, skip save
  }
}

export function loadGraph(): PersistedGraph | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const g = JSON.parse(raw) as PersistedGraph
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null
    const clean = sanitizeGraph(g)
    if (clean.nodes.length === 0 && clean.edges.length === 0) return null
    return clean
  } catch {
    return null
  }
}

export function clearSavedGraph(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

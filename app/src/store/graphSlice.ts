import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge as rfAddEdge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react'
import type { ComponentKind, PipeEdgeData } from '../model/types'
import type { SolveResult } from '../solver/contract'
import { CATALOG } from '../model/catalog'
import { makeNode, makeEdge, syncSeq, visualPipeLengthM, syncPipeLengths, type RFNode, type RFEdge } from './factory'
import { buildSeed } from './seed'
import { loadGraph } from './persist'

// Push the id counter past every id in a graph so freshly minted ids can't
// collide with existing ones (a collision makes React Flow drop the duplicate).
const resyncIds = (g: { nodes: RFNode[]; edges: RFEdge[] }) =>
  syncSeq([...g.nodes.map((n) => n.id), ...g.edges.map((e) => e.id)])

// best-guess pipe line from the connected port's supply/return hint, so a
// freshly drawn connection is coloured (hot/cold) instead of grey before the
// first solve recolours it by temperature.
function inferLine(node: RFNode | undefined, portId: string | null | undefined): PipeEdgeData['line'] {
  if (!node || !portId) return 'auto'
  const def = CATALOG[node.data.kind]
  if (!def) return 'auto' // unknown kind (corrupt import) — don't crash the connect
  const ports = def.dynamicPorts ? def.dynamicPorts(node.data.params) : def.ports
  return ports.find((p) => p.id === portId)?.hint ?? 'auto'
}

interface GraphState {
  nodes: RFNode[]
  edges: RFEdge[]
}

// restore the user's last design from localStorage, else the example house
const restored = loadGraph()
const seed = restored ?? buildSeed()
const initialState: GraphState = { nodes: seed.nodes as RFNode[], edges: seed.edges as RFEdge[] }
// A restored graph never ran buildSeed (which advances the counter), so without
// this the counter sits at 1 and the first new pipe reuses id `e1`.
resyncIds(initialState)
// pipe lengths follow the drawing — derive them from the seeded/restored positions
syncPipeLengths(initialState.nodes, initialState.edges)

const graphSlice = createSlice({
  name: 'graph',
  initialState,
  reducers: {
    nodesChanged(state, action: PayloadAction<NodeChange[]>) {
      state.nodes = applyNodeChanges(action.payload, state.nodes) as RFNode[]
      // when a drag finishes (the release carries dragging:false), re-derive pipe
      // lengths from the new positions. Done here (not every drag tick) so the
      // solver only re-runs once, on release.
      if (action.payload.some((c) => c.type === 'position' && c.dragging === false))
        syncPipeLengths(state.nodes, state.edges)
    },
    edgesChanged(state, action: PayloadAction<EdgeChange[]>) {
      state.edges = applyEdgeChanges(action.payload, state.edges) as RFEdge[]
    },
    connected(state, action: PayloadAction<Connection>) {
      const c = action.payload
      // reject self-loops (a component wired back into itself)
      if (!c.source || !c.target || c.source === c.target) return
      // reject an exact duplicate of an existing pipe
      if (
        state.edges.some(
          (e) =>
            e.source === c.source &&
            e.target === c.target &&
            e.sourceHandle === c.sourceHandle &&
            e.targetHandle === c.targetHandle,
        )
      )
        return
      const src = state.nodes.find((n) => n.id === c.source)
      const tgt = state.nodes.find((n) => n.id === c.target)
      let line = inferLine(src, c.sourceHandle)
      if (line === 'auto') line = inferLine(tgt, c.targetHandle)
      const edge = makeEdge(
        c.source!,
        c.sourceHandle ?? 'out',
        c.target!,
        c.targetHandle ?? 'in',
        line,
      )
      // length from the drawn distance between the two connected ports
      if (src && tgt && edge.data)
        edge.data.lengthM = visualPipeLengthM(src, c.sourceHandle, tgt, c.targetHandle)
      state.edges = rfAddEdge(edge, state.edges) as RFEdge[]
    },
    addComponent(
      state,
      action: PayloadAction<{ kind: ComponentKind; x: number; y: number }>,
    ) {
      const { kind, x, y } = action.payload
      state.nodes.push(makeNode(kind, x, y))
    },
    updateParam(
      state,
      action: PayloadAction<{ nodeId: string; key: string; value: number }>,
    ) {
      const n = state.nodes.find((nn) => nn.id === action.payload.nodeId)
      if (n) n.data.params = { ...n.data.params, [action.payload.key]: action.payload.value }
    },
    renameNode(state, action: PayloadAction<{ nodeId: string; label: string }>) {
      const n = state.nodes.find((nn) => nn.id === action.payload.nodeId)
      if (n) n.data.label = action.payload.label
    },
    setNodeEnabled(state, action: PayloadAction<{ nodeId: string; enabled: boolean }>) {
      const n = state.nodes.find((nn) => nn.id === action.payload.nodeId)
      if (n) n.data = { ...n.data, enabled: action.payload.enabled }
    },
    updateEdgeParam(
      state,
      action: PayloadAction<{ edgeId: string; key: 'lengthM' | 'diameterMm'; value: number }>,
    ) {
      const e = state.edges.find((ee) => ee.id === action.payload.edgeId)
      if (e && e.data) {
        e.data = { ...e.data, [action.payload.key]: action.payload.value }
        // a hand-typed length must survive drags/arranges that re-derive lengths
        if (action.payload.key === 'lengthM') e.data.lengthManual = true
      }
    },
    deleteSelected(state, action: PayloadAction<{ nodeId?: string; edgeId?: string }>) {
      const { nodeId, edgeId } = action.payload
      if (nodeId) {
        state.nodes = state.nodes.filter((n) => n.id !== nodeId)
        state.edges = state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
      }
      if (edgeId) state.edges = state.edges.filter((e) => e.id !== edgeId)
    },
    clearGraph(state) {
      state.nodes = []
      state.edges = []
    },
    replaceGraph(state, action: PayloadAction<{ nodes: RFNode[]; edges: RFEdge[] }>) {
      state.nodes = action.payload.nodes
      state.edges = action.payload.edges
      // imported / undo-redo graphs carry their own ids — keep the counter ahead
      resyncIds(action.payload)
      syncPipeLengths(state.nodes, state.edges)
    },
    duplicateNodes(state, action: PayloadAction<string[]>) {
      const ids = action.payload
      if (!ids.length) return
      const stamp = Math.max(0, ...state.nodes.map((n) => Number(n.id.replace(/\D/g, '')) || 0)) + 1
      const idMap = new Map<string, string>()
      ids.forEach((old, i) => idMap.set(old, `n${stamp + i}`))
      for (const old of ids) {
        const n = state.nodes.find((nn) => nn.id === old)
        if (!n) continue
        const nid = idMap.get(old)!
        state.nodes.push({
          ...n,
          id: nid,
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          selected: false,
          data: { ...n.data, params: { ...n.data.params }, result: undefined },
        })
      }
      // clone edges whose BOTH ends are in the duplicated set
      let eStamp = Math.max(0, ...state.edges.map((e) => Number(e.id.replace(/\D/g, '')) || 0)) + 1
      for (const e of state.edges.filter((ee) => idMap.has(ee.source) && idMap.has(ee.target))) {
        state.edges.push({
          ...e,
          id: `e${eStamp++}`,
          source: idMap.get(e.source)!,
          target: idMap.get(e.target)!,
          selected: false,
          data: e.data ? { ...e.data, result: undefined } : e.data,
        })
      }
      // the clones used locally-computed stamps; keep the global counter ahead too
      resyncIds(state)
      syncPipeLengths(state.nodes, state.edges)
    },
    loadSeed(state) {
      const s = buildSeed()
      state.nodes = s.nodes
      state.edges = s.edges
      resyncIds(s)
      syncPipeLengths(state.nodes, state.edges)
    },
    applyLayout(state, action: PayloadAction<Record<string, { x: number; y: number }>>) {
      for (const n of state.nodes) {
        const p = action.payload[n.id]
        if (p) n.position = p
      }
      // arranging moves everything — pipe lengths follow the new spacing
      syncPipeLengths(state.nodes, state.edges)
    },
    applyResults(state, action: PayloadAction<SolveResult>) {
      const res = action.payload
      for (const n of state.nodes) {
        const r = res.nodes[n.id]
        n.data = { ...n.data, result: r }
      }
      for (const e of state.edges) {
        const r = res.edges[e.id]
        if (e.data) e.data = { ...e.data, result: r }
      }
    },
  },
})

export const {
  nodesChanged,
  edgesChanged,
  connected,
  addComponent,
  updateParam,
  renameNode,
  setNodeEnabled,
  updateEdgeParam,
  deleteSelected,
  clearGraph,
  loadSeed,
  replaceGraph,
  duplicateNodes,
  applyLayout,
  applyResults,
} = graphSlice.actions

export default graphSlice.reducer

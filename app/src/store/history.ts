import { createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit'
import { replaceGraph } from './graphSlice'
import type { RFNode, RFEdge } from './factory'

// Minimal slice of state this middleware reads — declaring it locally (instead
// of importing RootState from ./store) breaks the store<->history type cycle
// that would otherwise collapse RootState to `any` across the whole app.
type GraphRoot = { graph: { nodes: RFNode[]; edges: RFEdge[] } }

// Lightweight undo/redo: the middleware keeps past/future snapshots of the graph
// topology (results & ui flags stripped). A tiny slice mirrors canUndo/canRedo so
// toolbar buttons can react. Node drags snapshot once at drag-START (so undo
// reverts the whole move, not each tick).

interface Snap {
  nodes: RFNode[]
  edges: RFEdge[]
}

const DROP = new Set(['result', 'selected', 'dragging', 'resizing'])
const clean = (g: { nodes: RFNode[]; edges: RFEdge[] }): Snap =>
  JSON.parse(JSON.stringify({ nodes: g.nodes, edges: g.edges }, (k, v) => (DROP.has(k) ? undefined : v)))

const past: Snap[] = []
const future: Snap[] = []
const LIMIT = 60

const MUTATING = new Set([
  'graph/connected',
  'graph/addComponent',
  'graph/updateParam',
  'graph/renameNode',
  'graph/setNodeEnabled',
  'graph/updateEdgeParam',
  'graph/deleteSelected',
  'graph/clearGraph',
  'graph/loadSeed',
  'graph/duplicateNodes',
  'graph/applyLayout',
])

export const undo = () => ({ type: 'history/undo' as const })
export const redo = () => ({ type: 'history/redo' as const })

const historySlice = createSlice({
  name: 'historyflags',
  initialState: { canUndo: false, canRedo: false },
  reducers: {
    setFlags(state, a: PayloadAction<{ canUndo: boolean; canRedo: boolean }>) {
      state.canUndo = a.payload.canUndo
      state.canRedo = a.payload.canRedo
    },
  },
})
const { setFlags } = historySlice.actions
export const historyReducer = historySlice.reducer

let dragging = false
let suppress = false // true while applying an undo/redo (don't re-snapshot)
// Deleting a node by key emits BOTH a node-remove and an edge-remove change in
// the same event handler; snapshot only once for the burst (the first change
// arrives before anything is removed, so it captures the full pre-delete state).
let removeBurst = false
// Consecutive edits of the SAME param (slider drag, spinner hold) coalesce into
// one snapshot so a drag doesn't flood the undo buffer with one-tick steps.
let lastEditKey: string | null = null

// A stable identity for a param edit, or null for anything that must always snapshot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editKeyOf(action: any): string | null {
  if (action.type === 'graph/updateParam') return `p:${action.payload?.nodeId}:${action.payload?.key}`
  if (action.type === 'graph/updateEdgeParam') return `e:${action.payload?.edgeId}:${action.payload?.key}`
  return null
}

export const historyMiddleware: Middleware<object, GraphRoot> =
  (api) =>
  (next) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (action: any) => {
    const snapshot = () => {
      past.push(clean(api.getState().graph))
      if (past.length > LIMIT) past.shift()
      future.length = 0
    }
    const sync = () => api.dispatch(setFlags({ canUndo: past.length > 0, canRedo: future.length > 0 }))
    const snapshotRemoval = () => {
      if (removeBurst) return
      removeBurst = true
      queueMicrotask(() => {
        removeBurst = false
      })
      snapshot()
      sync()
    }

    if (action.type === 'history/undo') {
      if (!past.length) return
      future.push(clean(api.getState().graph))
      const prev = past.pop()!
      suppress = true
      api.dispatch(replaceGraph(prev))
      suppress = false
      lastEditKey = null
      sync()
      return
    }
    if (action.type === 'history/redo') {
      if (!future.length) return
      past.push(clean(api.getState().graph))
      const nxt = future.pop()!
      suppress = true
      api.dispatch(replaceGraph(nxt))
      suppress = false
      lastEditKey = null
      sync()
      return
    }

    if (!suppress) {
      if (action.type === 'graph/nodesChanged') {
        const ch = action.payload as Array<{ type: string; dragging?: boolean }>
        const removing = ch.some((c) => c.type === 'remove')
        const dragStart = ch.some((c) => c.type === 'position' && c.dragging === true)
        const dragEnd = ch.some((c) => c.type === 'position' && c.dragging === false)
        if (removing) {
          lastEditKey = null
          snapshotRemoval()
        } else if (dragStart && !dragging) {
          lastEditKey = null
          snapshot()
          dragging = true
          sync()
        }
        if (dragEnd) dragging = false
      } else if (action.type === 'graph/edgesChanged') {
        // keyboard pipe delete flows through here (not deleteSelected) — record it
        const ch = action.payload as Array<{ type: string }>
        if (ch.some((c) => c.type === 'remove')) {
          lastEditKey = null
          snapshotRemoval()
        }
      } else if (action.type === 'graph/replaceGraph') {
        // a non-suppressed replaceGraph is an import — make it undoable
        lastEditKey = null
        snapshot()
        sync()
      } else if (MUTATING.has(action.type)) {
        const key = editKeyOf(action)
        if (!key || key !== lastEditKey) {
          snapshot()
          sync()
        }
        lastEditKey = key
      } else if (typeof action.type === 'string' && action.type.startsWith('selection/')) {
        // moving to another element ends the edit run — the next edit of the
        // same param is a new undoable step
        lastEditKey = null
      }
    }
    return next(action)
  }

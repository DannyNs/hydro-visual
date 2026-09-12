import { configureStore, type ThunkAction, type Action } from '@reduxjs/toolkit'
import graph from './graphSlice'
import selection from './selectionSlice'
import sim from './simSlice'
import ui from './uiSlice'
import playback from './playbackSlice'
import { historyReducer, historyMiddleware } from './history'
import { saveGraph } from './persist'

export const store = configureStore({
  reducer: { graph, selection, sim, ui, playback, historyflags: historyReducer },
  middleware: (getDefault) =>
    getDefault({ serializableCheck: false, immutableCheck: false }).concat(historyMiddleware),
})

// Autosave the design (topology only) to localStorage, debounced, so a reload
// restores the user's work. Skipped while a transient playback is computing/
// running to avoid churning storage on frame application.
let saveTimer: ReturnType<typeof setTimeout> | undefined
let lastSig = ''
let pendingSave = false

// Write the current topology now and clear the pending flag. Always reads fresh
// state so a flush persists the very latest edit.
function commitSave(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  pendingSave = false
  const { graph: g } = store.getState()
  saveGraph({ nodes: g.nodes, edges: g.edges })
}

store.subscribe(() => {
  const { graph: g } = store.getState()
  // topology signature: positions, kinds, labels, params, connections — but NOT
  // solver results (which change on every solve and shouldn't trigger a save).
  const sig = JSON.stringify([
    g.nodes.map((n) => [n.id, n.position.x, n.position.y, n.data.kind, n.data.label, n.data.params, n.data.enabled]),
    g.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle, e.data?.line, e.data?.lengthM, e.data?.diameterMm]),
  ])
  if (sig === lastSig) return
  lastSig = sig
  pendingSave = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(commitSave, 600)
})

// Flush a pending (still-debounced) save synchronously before the page goes
// away. Without this, an edit made in the last 600ms — e.g. deleting a pipe and
// immediately refreshing — is lost: the reload restores the pre-edit design and
// the change appears to "come back", which reads as the UI not updating. pagehide
// + visibilitychange(hidden) are the reliable unload signals (beforeunload isn't
// always fired, e.g. on mobile/bfcache); cover all three.
if (typeof window !== 'undefined') {
  const flush = () => {
    if (pendingSave) commitSave()
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
export type AppThunk<R = void> = ThunkAction<R, RootState, unknown, Action<string>>

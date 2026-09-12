import type { AppThunk } from './store'
import { deleteSelected, applyLayout } from './graphSlice'
import { clearSelection } from './selectionSlice'
import { bumpArrange } from './uiSlice'
import { computeLayout, LAYOUT_VARIANT_COUNT } from './layout'

// Remove whatever is currently selected (a component + its pipes, or a pipe),
// then clear the selection. Shared by the toolbar, inspector and Delete key.
export const removeSelected = (): AppThunk => (dispatch, getState) => {
  const { nodeId, edgeId } = getState().selection
  if (nodeId) dispatch(deleteSelected({ nodeId }))
  else if (edgeId) dispatch(deleteSelected({ edgeId }))
  dispatch(clearSelection())
}

export const removeNode = (nodeId: string): AppThunk => (dispatch) => {
  dispatch(deleteSelected({ nodeId }))
  dispatch(clearSelection())
}

// Tidy the graph into an auto-arranged layered layout. Each call advances to the
// NEXT layout variant (wrapping), so clicking the button repeatedly cycles through
// distinct arrangements and the user keeps whichever fits best. The variant is
// surfaced to the UI (a brief toast) via `bumpArrange`.
let arrangeCount = 0
export const autoArrange = (): AppThunk => (dispatch, getState) => {
  const { nodes, edges } = getState().graph
  if (!nodes.length) return
  const variant = arrangeCount++ % LAYOUT_VARIANT_COUNT
  dispatch(applyLayout(computeLayout(nodes, edges, variant)))
  dispatch(bumpArrange(variant))
}

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface SelectionState {
  nodeId?: string
  edgeId?: string
}

const initialState: SelectionState = {}

const selectionSlice = createSlice({
  name: 'selection',
  initialState,
  reducers: {
    selectNode(state, action: PayloadAction<string | undefined>) {
      state.nodeId = action.payload
      state.edgeId = undefined
    },
    selectEdge(state, action: PayloadAction<string | undefined>) {
      state.edgeId = action.payload
      state.nodeId = undefined
    },
    clearSelection(state) {
      state.nodeId = undefined
      state.edgeId = undefined
    },
  },
})

export const { selectNode, selectEdge, clearSelection } = selectionSlice.actions
export default selectionSlice.reducer

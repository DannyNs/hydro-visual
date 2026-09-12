import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { SolveResult } from '../solver/contract'
import { EMPTY_RESULT } from '../solver/contract'
import type { GraphWarning } from './validate'

interface SimState {
  running: boolean
  engine: 'wasm' | 'ts' | 'loading'
  result: SolveResult
  lastRunAt: number
  warnings: GraphWarning[]
}

const initialState: SimState = {
  running: false,
  engine: 'loading',
  result: EMPTY_RESULT,
  lastRunAt: 0,
  warnings: [],
}

const simSlice = createSlice({
  name: 'sim',
  initialState,
  reducers: {
    runStarted(state) {
      state.running = true
    },
    runFinished(state, action: PayloadAction<SolveResult>) {
      state.running = false
      state.result = action.payload
      state.lastRunAt = state.lastRunAt + 1
    },
    setResult(state, action: PayloadAction<SolveResult>) {
      // used by transient playback to show the current frame without toggling
      // the running flag
      state.result = action.payload
    },
    setEngine(state, action: PayloadAction<'wasm' | 'ts' | 'loading'>) {
      state.engine = action.payload
    },
    setWarnings(state, action: PayloadAction<GraphWarning[]>) {
      state.warnings = action.payload
    },
  },
})

export const { runStarted, runFinished, setResult, setEngine, setWarnings } = simSlice.actions
export default simSlice.reducer

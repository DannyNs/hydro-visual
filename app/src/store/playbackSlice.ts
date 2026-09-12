import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TransientFrame } from '../solver/contract'

interface PlaybackState {
  frames: TransientFrame[]
  idx: number
  playing: boolean
  /** simulated-time speed multiplier: 1 = real time, 60 = one sim-minute per real second */
  speed: number
  durationS: number
  /** simulated seconds elapsed since the start of the run (the on-screen clock) */
  simT: number
  /** simulated seconds at the final frame (the end of the timeline) */
  endT: number
  computing: boolean
}

const initialState: PlaybackState = {
  frames: [],
  idx: 0,
  playing: false,
  speed: 60,
  durationS: 0,
  simT: 0,
  endT: 0,
  computing: false,
}

// Index of the frame in effect at simulated time `simT`: the last frame whose
// timestamp has been reached (frames are ordered by ascending `t`).
function frameIndexAt(frames: TransientFrame[], simT: number): number {
  let i = 0
  for (let k = 0; k < frames.length; k++) {
    if (frames[k].t <= simT) i = k
    else break
  }
  return i
}

const playbackSlice = createSlice({
  name: 'playback',
  initialState,
  reducers: {
    computingStarted(state) {
      state.computing = true
    },
    setFrames(state, action: PayloadAction<{ frames: TransientFrame[]; durationS: number }>) {
      const { frames, durationS } = action.payload
      state.frames = frames
      state.durationS = durationS
      state.endT = frames.length ? frames[frames.length - 1].t : durationS
      state.idx = 0
      state.simT = 0
      state.computing = false
      state.playing = frames.length > 1
    },
    // Replace the timeline with a recomputed continuation (after a mid-run edit)
    // while keeping the simulated clock where it is — the run resumes from the
    // current warm state instead of restarting cold.
    resumeFrames(state, action: PayloadAction<{ frames: TransientFrame[]; simT: number }>) {
      const { frames, simT } = action.payload
      state.frames = frames
      state.endT = frames.length ? frames[frames.length - 1].t : simT
      state.simT = Math.max(0, Math.min(state.endT, simT))
      state.idx = frameIndexAt(frames, state.simT)
      state.computing = false
    },
    setIdx(state, action: PayloadAction<number>) {
      const max = Math.max(0, state.frames.length - 1)
      state.idx = Math.max(0, Math.min(max, Math.round(action.payload)))
      state.simT = state.frames[state.idx]?.t ?? 0
    },
    // Move the simulated clock to `simT` (seconds) and snap the shown frame to it.
    setSimT(state, action: PayloadAction<number>) {
      state.simT = Math.max(0, Math.min(state.endT, action.payload))
      state.idx = frameIndexAt(state.frames, state.simT)
    },
    play(state) {
      if (state.simT >= state.endT) {
        state.simT = 0
        state.idx = 0
      }
      state.playing = state.frames.length > 1
    },
    pause(state) {
      state.playing = false
    },
    setPlaying(state, action: PayloadAction<boolean>) {
      state.playing = action.payload
    },
    setSpeed(state, action: PayloadAction<number>) {
      state.speed = action.payload
    },
    resetPlayback(state) {
      state.idx = 0
      state.simT = 0
      state.playing = state.frames.length > 1
    },
    clearFrames(state) {
      state.frames = []
      state.idx = 0
      state.simT = 0
      state.endT = 0
      state.playing = false
      state.computing = false
    },
  },
})

export const {
  computingStarted,
  setFrames,
  resumeFrames,
  setIdx,
  setSimT,
  play,
  pause,
  setPlaying,
  setSpeed,
  resetPlayback,
  clearFrames,
} = playbackSlice.actions

export default playbackSlice.reducer

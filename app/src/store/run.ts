import type { AppThunk } from './store'
import { graphToSolveRequest } from './factory'
import { solveAsync, solveTransientAsync } from '../solver/client'
import { EMPTY_RESULT, type SolveResult, type TransientFrame } from '../solver/contract'
import { runStarted, runFinished, setResult, setWarnings } from './simSlice'
import { computingStarted, setFrames, resumeFrames } from './playbackSlice'
import { applyResults } from './graphSlice'
import { validateGraph, resultWarnings } from './validate'

// Monotonic solve counter: solves run async in a worker, so a slow earlier solve
// could resolve after a newer one and overwrite the canvas with stale results.
// Each run claims a generation; results from a superseded generation are dropped.
let solveGen = 0

// Serialize the current graph, solve it in the worker, write results back.
export const runSimulation = (): AppThunk<Promise<void>> => async (dispatch, getState) => {
  const gen = ++solveGen
  const { graph } = getState()
  dispatch(setWarnings(validateGraph(graph.nodes, graph.edges)))
  // empty canvas: clear the results panel rather than leaving stale numbers
  if (graph.nodes.length === 0) {
    dispatch(runFinished(EMPTY_RESULT))
    dispatch(applyResults(EMPTY_RESULT))
    return
  }
  dispatch(runStarted())
  const req = graphToSolveRequest(graph.nodes, graph.edges)
  const res = await solveAsync(req)
  if (gen !== solveGen) return // a newer solve started; its result wins
  dispatch(runFinished(res))
  dispatch(applyResults(res))
  // refine the design warnings with flow/pressure-dependent ones (pumps fighting,
  // pressure out of band) now that we have a solved result
  dispatch(
    setWarnings([
      ...validateGraph(graph.nodes, graph.edges),
      ...resultWarnings(graph.nodes, graph.edges, res),
    ]),
  )
}

// Build a frame as a SolveResult so the existing render path can show it.
export function frameToResult(frame: TransientFrame): SolveResult {
  return {
    status: 'converged',
    iterations: 0,
    residual: 0,
    elapsedMs: 0,
    global: frame.global,
    edges: frame.edges,
    nodes: frame.nodes,
    history: [],
  }
}

// Apply a transient frame to the canvas + results panel. With no argument it
// applies the frame the playback clock currently points at (idx in state).
export const applyFrame =
  (idx?: number): AppThunk =>
  (dispatch, getState) => {
    const pb = getState().playback
    const frame = pb.frames[idx ?? pb.idx]
    if (!frame) return
    const r = frameToResult(frame)
    dispatch(applyResults(r))
    dispatch(setResult(r))
  }

// Transient runs are async; an edit can fire a recompute while a cold run is
// still in flight. Each claims a generation; a superseded run drops its result.
let transientGen = 0
const TRANSIENT_OPTS = { durationS: 10800, frameCount: 180, layers: 10 }

// Compute the cold-start transient and start playback.
export const runTransient = (): AppThunk<Promise<void>> => async (dispatch, getState) => {
  const { graph } = getState()
  if (graph.nodes.length === 0) return
  const gen = ++transientGen
  dispatch(computingStarted())
  const req = graphToSolveRequest(graph.nodes, graph.edges)
  req.mode = 'transient'
  // Cover a full cold-start (a big buffer can take 2-3 h) and record plenty of
  // frames so the real-time clock animates smoothly. The march auto-stops once
  // the system reaches steady state, so a longer window costs nothing if it
  // settles sooner.
  req.transient = { ...TRANSIENT_OPTS }
  const res = await solveTransientAsync(req)
  if (gen !== transientGen) return // a newer run/recompute supersedes this one
  dispatch(setFrames({ frames: res.frames, durationS: res.durationS }))
  if (res.frames.length) dispatch(applyFrame(0))
}

// Re-solve the transient after a mid-run edit (toggling a pump/valve/heater,
// changing a param) WITHOUT restarting cold: seed the new run with the tank
// temperatures at the current clock position, then graft its frames onto the
// timeline at `simT` so the buffer keeps evolving from where it was — now under
// the edited configuration (e.g. heater off → buffer stops rising and cools as
// the loads keep drawing; a valve opening → flow appears).
export const recomputeTransient = (): AppThunk<Promise<void>> => async (dispatch, getState) => {
  const st = getState()
  if (st.ui.simMode !== 'transient') return
  const pb = st.playback
  if (pb.frames.length < 2) {
    void dispatch(runTransient()) // nothing to resume from yet — cold start
    return
  }
  const gen = ++transientGen
  const initialTankTemps = pb.frames[pb.idx]?.tankTemps
  const req = graphToSolveRequest(st.graph.nodes, st.graph.edges)
  req.mode = 'transient'
  req.transient = { ...TRANSIENT_OPTS, initialTankTemps }
  const res = await solveTransientAsync(req)
  if (gen !== transientGen || getState().ui.simMode !== 'transient') return
  // Re-read the clock AFTER the await — the user may have scrubbed the timeline
  // while the solve was in flight; grafting at the stale simT would splice the
  // new frames into the wrong spot and leave a timeline discontinuity.
  const nowT = getState().playback.simT
  // keep the already-played history, append the recomputed future rebased to now
  const history = pb.frames.filter((f) => f.t < nowT)
  const future = res.frames.map((f) => ({ ...f, t: f.t + nowT }))
  dispatch(resumeFrames({ frames: [...history, ...future], simT: nowT }))
  dispatch(applyFrame())
}

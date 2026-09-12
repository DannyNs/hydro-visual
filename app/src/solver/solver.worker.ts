/// <reference lib="webworker" />
import { solve as tsSolve } from './tsSolver'
import { solveTransient } from './transient'
import type { WorkerRequest, WorkerResponse, SolveResult, SolveRequest } from './contract'

let wasmSolve: ((json: string) => string) | null = null
let engine: 'wasm' | 'ts' = 'ts'

async function tryLoadWasm(): Promise<void> {
  try {
    // wasm-pack --target web glue, served from app/public/solver. Build the URL
    // from the runtime origin so neither Vite's dev import-analysis nor TS tries
    // to resolve it (a "/"-rooted literal trips Vite's /public guard). init()
    // then fetches hydro_solver_bg.wasm relative to the glue. Falls back to the
    // TS solver if the file isn't there yet.
    const url = self.location.origin + '/solver/hydro_solver.js'
    const mod = (await import(/* @vite-ignore */ url)) as {
      default: () => Promise<unknown>
      solve?: unknown
    }
    await mod.default()
    if (typeof mod.solve === 'function') {
      wasmSolve = mod.solve as (json: string) => string
      engine = 'wasm'
    }
  } catch {
    engine = 'ts'
  }
  postMessage({ type: 'ready', engine } satisfies WorkerResponse)
}

void tryLoadWasm()

// Accept a wasm result only if it actually converged with positive flow and no
// unphysical temps (NaN, or colder than the ambient it started from). Anything
// else — empty, diverged, NaN, sub-ambient — falls back to the TS reference,
// which is the trusted model for these topologies.
function isSane(r: SolveResult, req: SolveRequest): boolean {
  if (!r || r.status !== 'converged') return false
  if (!Number.isFinite(r.global.flowM3h) || r.global.flowM3h <= 1e-3) return false
  const floor = (req.ambientC ?? 20) - 3
  for (const k in r.edges) {
    const t = r.edges[k].tempC
    if (!Number.isFinite(t) || t < floor) return false
  }
  const g = r.global
  if (!Number.isFinite(g.supplyC) || !Number.isFinite(g.returnC)) return false
  if (g.supplyC < floor) return false
  // capability check: an engine too old to know a role would echo those nodes
  // without a result — fall back to TS, which handles every role. group, manifold
  // and the 2-zone buffer (non-DHW tank) all must report a supply temp.
  for (const n of req.nodes) {
    if (n.role === 'group' && r.nodes[n.id]?.supplyC === undefined) return false
    if (n.role === 'manifold' && r.nodes[n.id]?.supplyC === undefined) return false
    if (n.role === 'tank' && n.params?.setpointC === undefined && r.nodes[n.id]?.supplyC === undefined)
      return false
    // 'check' is a one-way role the current wasm doesn't enforce — always solve
    // such graphs in TS so reverse flow through a check valve is actually blocked.
    if (n.role === 'check') return false
  }
  return true
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  if (msg.type === 'transient') {
    // transient is TS-only for now (cold-start time-stepping)
    const result = solveTransient(msg.request)
    postMessage({ type: 'transient', id: msg.id, result, engine: 'ts' } satisfies WorkerResponse)
    return
  }
  if (msg.type !== 'solve') return
  let result: SolveResult
  let used: 'wasm' | 'ts' = 'ts'
  if (wasmSolve) {
    try {
      const r: SolveResult = JSON.parse(wasmSolve(JSON.stringify(msg.request)))
      if (isSane(r, msg.request)) {
        result = r
        used = 'wasm'
      } else {
        result = tsSolve(msg.request)
        used = 'ts'
      }
    } catch {
      result = tsSolve(msg.request)
      used = 'ts'
    }
  } else {
    result = tsSolve(msg.request)
    used = 'ts'
  }
  postMessage({ type: 'result', id: msg.id, result, engine: used } satisfies WorkerResponse)
}

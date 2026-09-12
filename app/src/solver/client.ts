import type {
  SolveRequest,
  SolveResult,
  TransientResult,
  WorkerResponse,
} from './contract'

// Main-thread client for the solver worker. Lazily spawns the worker and
// multiplexes solve / transient requests by id.

let worker: Worker | null = null
let reqId = 0
const pending = new Map<number, (r: unknown) => void>()
const readyCbs: ((engine: 'wasm' | 'ts') => void)[] = []

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data
    if (msg.type === 'result' || msg.type === 'transient') {
      for (const cb of readyCbs) cb(msg.engine)
      const cb = pending.get(msg.id)
      if (cb) {
        cb(msg.result)
        pending.delete(msg.id)
      }
    } else if (msg.type === 'ready') {
      for (const cb of readyCbs) cb(msg.engine)
    }
  }
  return worker
}

// Subscribe to engine-ready/used notifications. Returns an unsubscribe so the
// caller's effect can clean up — without it, React StrictMode (and any remount)
// would push the same callback repeatedly into readyCbs and never remove it,
// leaking listeners and dispatching setEngine N times per solve.
export function onEngineReady(cb: (engine: 'wasm' | 'ts') => void): () => void {
  if (!readyCbs.includes(cb)) readyCbs.push(cb)
  ensureWorker()
  return () => {
    const i = readyCbs.indexOf(cb)
    if (i !== -1) readyCbs.splice(i, 1)
  }
}

export function solveAsync(req: SolveRequest): Promise<SolveResult> {
  const w = ensureWorker()
  const id = ++reqId
  return new Promise<SolveResult>((resolve) => {
    pending.set(id, resolve as (r: unknown) => void)
    w.postMessage({ type: 'solve', id, request: req })
  })
}

export function solveTransientAsync(req: SolveRequest): Promise<TransientResult> {
  const w = ensureWorker()
  const id = ++reqId
  return new Promise<TransientResult>((resolve) => {
    pending.set(id, resolve as (r: unknown) => void)
    w.postMessage({ type: 'transient', id, request: req })
  })
}

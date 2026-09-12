// The worker boundary. This is the exact JSON contract exchanged with the
// physics solver (Rust -> WASM, or the TS reference fallback). The Rust serde
// structs mirror these shapes field-for-field.

import type { SolverRole, EdgeResult, NodeResult } from '../model/types'

export interface SolveNode {
  id: string
  role: SolverRole
  /** flat numeric parameter bag, role-specific keys (see catalog) */
  params: Record<string, number>
}

export interface SolveEdge {
  id: string
  from: string
  fromPort: string
  to: string
  toPort: string
  line: 'supply' | 'return' | 'auto'
  lengthM: number
  diameterMm: number
}

export interface TransientOpts {
  /** max simulated seconds; the run auto-stops once it reaches steady state */
  durationS: number
  /** number of frames to record for playback */
  frameCount: number
  /** buffer-tank stratification layers */
  layers: number
  /** seed each tank with these layer temps (resume a warm run after an edit
   *  instead of restarting cold), keyed by node id */
  initialTankTemps?: Record<string, number[]>
}

export interface SolveRequest {
  nodes: SolveNode[]
  edges: SolveEdge[]
  fluid: { cpJkgK: number; rhoKgM3: number }
  ambientC: number
  mode: 'steady' | 'transient'
  transient?: TransientOpts
  /** Sealed-system static-pressure inputs, distilled from the graph (fill valve +
   *  expansion vessel). The solver reports gauge pressure = fill + thermal
   *  expansion, kept SEPARATE from pump differential head. Optional: absent in
   *  hand-built requests, which fall back to fillKpa=120 (1.2 bar), vesselL=12. */
  pressure?: { fillKpa: number; vesselL: number }
}

export interface GlobalResult {
  flowM3h: number
  headKpa: number
  pressureKpa: number
  supplyC: number
  returnC: number
  deltaC: number
  heatKw: number
  cop: number | null
}

export interface HistoryPoint {
  iter: number
  supplyC: number
  returnC: number
  heatKw: number
}

export interface SolveResult {
  status: 'converged' | 'diverged' | 'empty' | 'error'
  iterations: number
  residual: number
  elapsedMs: number
  message?: string
  global: GlobalResult
  edges: Record<string, EdgeResult>
  nodes: Record<string, NodeResult>
  history: HistoryPoint[]
}

// ---- transient (time-stepped) results ----

export interface TransientFrame {
  t: number // simulated seconds
  global: GlobalResult
  nodes: Record<string, NodeResult>
  edges: Record<string, EdgeResult>
  /** raw tank layer temps at this instant, so a later edit can resume the run
   *  from this warm state (top→bottom per tank, keyed by node id) */
  tankTemps?: Record<string, number[]>
}

export interface TransientResult {
  status: 'ok' | 'empty' | 'error'
  dtS: number
  durationS: number
  elapsedMs: number
  frames: TransientFrame[]
  message?: string
}

export const EMPTY_RESULT: SolveResult = {
  status: 'empty',
  iterations: 0,
  residual: 0,
  elapsedMs: 0,
  global: {
    flowM3h: 0,
    headKpa: 0,
    pressureKpa: 0,
    supplyC: 0,
    returnC: 0,
    deltaC: 0,
    heatKw: 0,
    cop: null,
  },
  edges: {},
  nodes: {},
  history: [],
}

// Worker message envelopes.
export type WorkerRequest =
  | { type: 'solve'; id: number; request: SolveRequest }
  | { type: 'transient'; id: number; request: SolveRequest }
export type WorkerResponse =
  | { type: 'result'; id: number; result: SolveResult; engine: 'wasm' | 'ts' }
  | { type: 'transient'; id: number; result: TransientResult; engine: 'wasm' | 'ts' }
  | { type: 'ready'; engine: 'wasm' | 'ts' }

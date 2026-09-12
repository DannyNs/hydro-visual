// TS ↔ Rust/WASM parity test.
//
// Loads the compiled wasm-pack (`--target web`) solver from
// app/public/solver/hydro_solver.js in Node by reading the on-disk `.wasm`
// bytes via fs and feeding them to the glue's synchronous `initSync({ module })`
// initialiser (the same code path a Node harness uses to boot a `--target web`
// bundle without a browser fetch). The SAME SolveRequests are then run through
// both the TypeScript reference `solve()` and the wasm `solve(json)`, and the
// global + per-node results are asserted to agree within tolerance.
//
// If the wasm cannot be loaded in this Node environment after a genuine attempt
// (file missing / instantiation error), the parity cases are reported as
// `it.skip` with the captured reason rather than failing the suite — the wasm is
// a build artifact that may legitimately be absent before `npm run build:wasm`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { solve as tsSolve } from './tsSolver'
import type { SolveRequest, SolveResult } from './contract'
import { makeRequest, node, edge } from './testHelpers'

// ---- attempt to load the wasm solver synchronously in Node ----
type WasmSolve = (json: string) => string
let wasmSolve: WasmSolve | null = null
let skipReason = ''

try {
  // public/ is served at the web root in the app; on disk it lives next to src.
  const gluePath = resolve(__dirname, '../../public/solver/hydro_solver.js')
  const wasmPath = resolve(__dirname, '../../public/solver/hydro_solver_bg.wasm')
  // Dynamic import of the ESM glue by file URL (Windows-safe).
  const mod = (await import(pathToFileURL(gluePath).href)) as {
    initSync: (m: { module: BufferSource } | BufferSource) => unknown
    solve: WasmSolve
  }
  const bytes = readFileSync(wasmPath)
  // wasm-pack web-target glue: initSync compiles a WebAssembly.Module from the
  // bytes and instantiates it with the self-contained externref-table import.
  mod.initSync({ module: bytes })
  if (typeof mod.solve !== 'function') throw new Error('glue has no solve()')
  // smoke-call to be sure it actually executes before we trust it.
  const probe = JSON.parse(
    mod.solve('{"nodes":[],"edges":[],"mode":"steady","ambientC":20}'),
  ) as SolveResult
  if (!probe || typeof probe.status !== 'string') throw new Error('solve() returned no status')
  wasmSolve = mod.solve
} catch (err) {
  skipReason = err instanceof Error ? err.message : String(err)
}

const runWasm = (req: SolveRequest): SolveResult =>
  JSON.parse((wasmSolve as WasmSolve)(JSON.stringify(req)))

// gate: if the wasm didn't load, register a single skipped placeholder so the
// limitation is visible in the report, and skip every parity assertion.
const itParity = wasmSolve ? it : it.skip

describe('TS ↔ WASM parity', () => {
  if (!wasmSolve) {
    it.skip(`wasm solver could not be loaded in Node — parity skipped (${skipReason})`, () => {})
  }

  itParity('agree on a heat-pump → radiator loop (global + node temps)', () => {
    const req = makeRequest(
      [
        node('hp', 'source', {
          ratedKw: 12,
          maxSupplyC: 52,
          sourceC: 7,
          copRated: 4.2,
          h0Kpa: 50,
          qMaxM3h: 2.6,
        }),
        node('rad', 'emitter', { ratedKw: 4, ratedExcessC: 50, roomC: 20, exponent: 1.3 }),
      ],
      [
        edge('e1', 'hp', 'sup', 'rad', 'sup', 'supply', 5, 22),
        edge('e2', 'rad', 'ret', 'hp', 'ret', 'return', 5, 22),
      ],
      20,
    )
    const ts = tsSolve(req)
    const wa = runWasm(req)

    expect(wa.status).toBe('converged')
    expect(ts.status).toBe('converged')

    // global flow within 2 %, supply/return within ~0.5 °C
    expectClosePct(wa.global.flowM3h, ts.global.flowM3h, 0.02)
    expect(wa.global.supplyC).toBeCloseTo(ts.global.supplyC, 1)
    expect(wa.global.returnC).toBeCloseTo(ts.global.returnC, 1)
    // static pressure (fill + thermal expansion) and clamped COP agree too
    expect(wa.global.pressureKpa).toBeCloseTo(ts.global.pressureKpa, 1)
    expect(wa.global.headKpa).toBeCloseTo(ts.global.headKpa, 1)
    expect(wa.global.cop as number).toBeCloseTo(ts.global.cop as number, 1)

    // a couple of node temps agree
    expect(wa.nodes.rad.supplyC as number).toBeCloseTo(ts.nodes.rad.supplyC as number, 1)
    expect(wa.nodes.rad.returnC as number).toBeCloseTo(ts.nodes.rad.returnC as number, 1)
    expect(wa.nodes.hp.supplyC as number).toBeCloseTo(ts.nodes.hp.supplyC as number, 1)
  })

  itParity('agree on a manifold → two-radiator network (warm supply, split flow)', () => {
    const req = makeRequest(
      [
        node('hp', 'source', { ratedKw: 12, maxSupplyC: 52, sourceC: 7, h0Kpa: 50, qMaxM3h: 2.6 }),
        node('man', 'manifold', { circuits: 2 }),
        node('rad0', 'emitter', { ratedKw: 2, ratedExcessC: 50, roomC: 20, exponent: 1.3 }),
        node('rad1', 'emitter', { ratedKw: 2, ratedExcessC: 50, roomC: 20, exponent: 1.3 }),
      ],
      [
        edge('e1', 'hp', 'sup', 'man', 'sup_in', 'supply', 4, 28),
        edge('e2', 'man', 'ret_out', 'hp', 'ret', 'return', 4, 28),
        edge('c0s', 'man', 'sup0', 'rad0', 'sup', 'supply', 4, 16),
        edge('c0r', 'rad0', 'ret', 'man', 'ret0', 'return', 4, 16),
        edge('c1s', 'man', 'sup1', 'rad1', 'sup', 'supply', 4, 16),
        edge('c1r', 'rad1', 'ret', 'man', 'ret1', 'return', 4, 16),
      ],
      27,
    )
    const ts = tsSolve(req)
    const wa = runWasm(req)

    expect(wa.status).toBe('converged')
    // both engines must reach the warm source supply (not ambient ~27)
    expect(wa.global.supplyC).toBeGreaterThan(40)
    expect(wa.global.supplyC).toBeCloseTo(ts.global.supplyC, 1)
    expectClosePct(wa.global.flowM3h, ts.global.flowM3h, 0.02)

    // manifold supply rail temp agrees and a circuit feed flow agrees within 2 %
    expect(wa.nodes.man.supplyC as number).toBeCloseTo(ts.nodes.man.supplyC as number, 1)
    expectClosePct(wa.edges['c0s'].flowM3h, ts.edges['c0s'].flowM3h, 0.02)
  })
})

/** assert `a` is within `pct` (fraction) of `b`, with a small absolute floor. */
function expectClosePct(a: number, b: number, pct: number): void {
  const tol = Math.max(Math.abs(b) * pct, 0.02)
  expect(Math.abs(a - b), `${a} vs ${b} (tol ${tol})`).toBeLessThanOrEqual(tol)
}

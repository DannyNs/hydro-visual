# Development Guide

Working notes for developing the Hydronic System Designer & Simulator. For an
end-user / feature overview see [README.md](README.md). Everything below assumes
you are working inside the `app/` workspace unless noted.

```bash
cd app
npm install
```

---

## 1. Architecture: the three-solver mirror

The physics is implemented **three times against one JSON contract**
(`app/src/solver/contract.ts`). All three MUST stay in lock-step — they are
checked against each other by the test suite and at runtime.

| # | File | Role |
|---|------|------|
| 1 | `app/src/solver/tsSolver.ts` | **Steady-state TypeScript reference.** The trusted model and correctness oracle. Linear-theory nodal hydraulics + component-sweep thermal energy balance. |
| 2 | `app/src/solver/transient.ts` | **Time-stepped TypeScript solver.** Cold-start transient (frame-by-frame) simulation used for playback. Shares the same roles/params/port model as the reference. |
| 3 | `solver/src/lib.rs` | **Rust → WebAssembly production engine.** Mirrors `tsSolver.ts` field-for-field (serde `rename_all = "camelCase"`), compiled to `app/public/solver/` via `wasm-pack`. |

At runtime the worker (`app/src/solver/solver.worker.ts`) prefers the **wasm**
engine but validates every result (must be `converged`, positive flow, no
sub-ambient temps, and must understand every role in the request); if a result
fails validation — or wasm hasn't loaded — it falls back to `tsSolver.ts`. The
engine actually used is reported back to the UI.

### Rule: a new component role touches all three + a wasm rebuild

A "role" is the physics behaviour of a component (`source`, `pump`, `group`,
`emitter`, `tank`, `junction`, `manifold`, `valve`, `passive` — see
`app/src/model/types.ts`). Components map to a role in `app/src/model/catalog.ts`.

When you **add or change a solver role**, you must update **all four** of:

1. `app/src/solver/tsSolver.ts` — the reference hydraulic branch(es) + thermal rule.
2. `app/src/solver/transient.ts` — the matching transient behaviour.
3. `solver/src/lib.rs` — the Rust implementation (same branches, same thermal rule).
4. **Rebuild the wasm** so `app/public/solver/` reflects the new Rust code:
   `npm run build:wasm`.

If you skip the Rust side (3/4), the worker's validation will detect the missing
capability and silently fall back to TS — the app keeps working, but the wasm
engine is now stale/incorrect for that role. The parity test
(`app/src/solver/parity.test.ts`) exists to catch exactly this drift: it runs the
same requests through both `tsSolver.ts` and the compiled wasm and asserts they
agree. **Run the tests after any solver change.**

Adding a component *kind* without a new role is lighter weight: one entry in
`app/src/model/catalog.ts` (category, ports, default params, role) plus an SVG in
`app/src/canvas/glyphs.tsx`. No solver change, no wasm rebuild.

### Repo layout

```
app/
  src/
    model/        domain types, component catalog (single source of truth), colors
    store/        Redux Toolkit slices (graph/selection/sim/ui/playback), seed, factory
    canvas/       React Flow canvas, equipment nodes, temperature pipe edges
    components/   palette, toolbar, results/legend/inspector, charts, status bar
    solver/       contract + the two TS solvers + wasm bridge + worker + client
  public/solver/  wasm-pack build output (hydro_solver.js + _bg.wasm) — SERVED at /solver
  scripts/        build-wasm.mjs and other dev scripts
  shot.cjs        headless Edge screenshot harness (see §5)
solver/           Rust crate (cargo), compiled to wasm via wasm-pack
```

---

## 2. Running the app (dev)

```bash
cd app
npm run dev          # Vite dev server -> http://localhost:5173
```

The solver runs in a Web Worker (ES module). On boot the worker tries to load the
wasm engine from `/solver/hydro_solver.js` (served out of `app/public/solver/`); if
those files are missing it falls back to the TS reference solver, so `npm run dev`
works even before you've ever built the wasm.

```bash
npm run build        # production bundle into app/dist
npm run preview      # serve the production build on :5173
```

---

## 3. Rebuilding the wasm solver

The compiled wasm in `app/public/solver/` is a **build artifact of the Rust crate**
in `solver/`. Rebuild it whenever you change `solver/src/lib.rs`:

```bash
cd app
npm run build:wasm           # release build
npm run build:wasm -- --dev  # faster, larger debug build
```

This runs `scripts/build-wasm.mjs`, which shells out to `wasm-pack build` with
`--target web` and writes `hydro_solver.js`, `hydro_solver_bg.wasm`, and the
`.d.ts` files into `app/public/solver/`. wasm-pack always drops a `.gitignore`
into its output dir that would ignore the whole bundle; the script deletes it
afterward because these files are served from `public/` and must not be ignored.

**Prerequisites:** a Rust toolchain and `wasm-pack` on `PATH`
(`cargo install wasm-pack`). The script is cross-platform (plain Node, no shell
script) and runs on Windows.

> The `--target web` glue is loadable in Node via `initSync({ module: <bytes> })`
> — that's exactly how `parity.test.ts` boots the wasm without a browser. If you
> change how the wasm is built, keep that entry point working or the parity test
> will skip.

---

## 4. Tests, types, lint, format

All commands run from `app/`.

```bash
npm test            # vitest run (one-shot)
npm run test:watch  # vitest watch mode
npm run test:coverage   # v8 coverage (solver/store/model)

npm run typecheck   # tsc --noEmit   (alias of `tsc --noEmit`)
npm run lint        # eslint . (advisory: reports warnings, does not gate)
npm run format      # prettier --write on src + root config files
```

### Test layout & environments

Vitest (`app/vitest.config.ts`) selects the environment **per file path**:

- `src/solver/**` → **node** environment. The solver is pure number-crunching; running
  it in Node is faster and lets the parity test `initSync` the wasm from disk.
- everything else → **jsdom**, with `@testing-library/react` +
  `@testing-library/jest-dom` (matchers registered in `app/vitest.setup.ts`).

A file can override its environment with a top-of-file docblock, e.g.
`// @vitest-environment jsdom`.

Current solver test suites:

- **`app/src/solver/tsSolver.test.ts`** — builds `SolveRequest`s in code (same shape
  `store/factory.ts::graphToSolveRequest` emits) and asserts real converged physics:
  heat-pump→radiator loop warms to the source cap, per-node **mass conservation**
  (signed edge-flow sum < 0.01 m³/h at every non-reference node), a no-pump graph
  returns empty/zero flow, and a manifold→two-radiator network reaches a **warm**
  supply (not ambient) with **both circuits carrying flow** (no short-circuit).
- **`app/src/solver/parity.test.ts`** — runs the same requests through both
  `tsSolver.ts` and the compiled wasm and asserts global flow, supply/return, and a
  couple of node temps agree within tolerance (~0.5 °C / 2 %). If the wasm can't be
  loaded in Node it self-skips with a reason instead of failing.
- **`app/src/solver/testHelpers.ts`** — shared `makeRequest`/`node`/`edge` builders +
  the `nodeNetFlows` mass-conservation helper (test-only, not imported by app code).

> **Mass-conservation note:** the hydraulic reference (slack) node is the owner of
> port 0. For a `source`-first graph that's `<source>:ret`, so the source node carries
> the rounding slack and is excluded from the per-node continuity assertion.

### Linting is advisory

`eslint.config.js` is a flat config (`typescript-eslint` + `eslint-plugin-react-hooks`).
Rules that would otherwise force edits to existing `src/**` (unused vars, `any` at the
wasm boundary, hook deps) are set to **warn**, not error. `npm run lint` is expected to
report a handful of warnings; treat them as a cleanup backlog, not a build gate. Build
artifacts (`dist/`, `public/solver/`, `coverage/`) are ignored.

---

## 5. The screenshot harness (`app/shot.cjs`)

`app/shot.cjs` is a headless **Microsoft Edge** (puppeteer-core) harness for capturing
a screenshot of the running app and surfacing any console / page errors — useful for
quick visual verification and for agents that can't open a browser.

```bash
cd app
npm run dev            # in one terminal — the harness expects a server on :5173
node shot.cjs          # in another — writes app/shot.png, prints SHOT: <path> and ERRORS:
```

It launches Edge from the standard Windows install path
(`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`), navigates to the app,
waits for the React-Flow canvas to render, and screenshots a 1536×1024 viewport.
Environment overrides:

- `SHOT_URL` — page to load (default `http://localhost:5173/`).
- `SHOT_OUT` — output filename relative to `app/` (default `shot.png`).

```bash
SHOT_URL=http://localhost:5173/ SHOT_OUT=after.png node shot.cjs
```

The harness collects `console` errors and uncaught `pageerror`s and prints them after
the shot, so a blank or broken render shows up as a non-empty `ERRORS:` list.

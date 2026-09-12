import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest configuration.
//
// Two execution environments are used, selected per-file by path:
//   * `node`  — the solver tests (`src/solver/**`). Pure number-crunching that
//     never touches the DOM; running them in Node is faster and lets the
//     wasm-pack `--target web` glue be `initSync`-ed from on-disk bytes for the
//     TS<->Rust parity check.
//   * `jsdom` — everything else (React component / store tests), which need a
//     DOM for `@testing-library/react` + `@testing-library/jest-dom`.
//
// A file can always override its environment with a top-of-file docblock:
//   // @vitest-environment jsdom
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // default to jsdom for component/UI tests…
    environment: 'jsdom',
    // …but run the solver suites in plain Node.
    environmentMatchGlobs: [['src/solver/**', 'node']],
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The solver is the unit-tested core; exclude UI/glue/config from the
      // coverage denominator so the number reflects logic actually under test.
      include: ['src/solver/**', 'src/store/**', 'src/model/**'],
      exclude: [
        'src/**/*.d.ts',
        'src/solver/solver.worker.ts',
        'src/solver/client.ts',
        '**/*.{test,spec}.{ts,tsx}',
      ],
    },
  },
})

#!/usr/bin/env node
// Cross-platform wasm build: compiles the Rust solver crate (../solver) to a
// wasm-pack `--target web` bundle directly into app/public/solver, where the
// solver worker loads it at runtime (self.location.origin + '/solver/...').
//
// wasm-pack always (re)creates a `.gitignore` inside its --out-dir that ignores
// the whole directory; since these artifacts are SERVED from public/ we delete
// that file after the build so the bundle isn't accidentally ignored.
//
// Usage:  npm run build:wasm   [-- --dev]
//   --dev / --debug : build the (faster, larger) debug profile instead of release.

import { spawnSync } from 'node:child_process'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..') // app/
const crateDir = resolve(appDir, '..', 'solver') // ../solver
const outDir = resolve(appDir, 'public', 'solver') // app/public/solver

const args = process.argv.slice(2)
const dev = args.includes('--dev') || args.includes('--debug')

if (!existsSync(crateDir)) {
  console.error(`[build:wasm] solver crate not found at ${crateDir}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const wasmPackArgs = [
  'build',
  crateDir,
  '--target',
  'web',
  '--out-dir',
  outDir,
  '--out-name',
  'hydro_solver',
  dev ? '--dev' : '--release',
  // (TypeScript .d.ts files are emitted by default — do not pass --no-typescript.)
]

console.log(`[build:wasm] wasm-pack ${wasmPackArgs.join(' ')}`)

// wasm-pack is the only external dependency; run it and inherit stdio so the
// Rust/cargo output is visible. `shell: true` lets Windows resolve wasm-pack.cmd.
const res = spawnSync('wasm-pack', wasmPackArgs, {
  stdio: 'inherit',
  shell: true,
})

if (res.error) {
  console.error('[build:wasm] failed to launch wasm-pack:', res.error.message)
  console.error('[build:wasm] is wasm-pack installed?  cargo install wasm-pack')
  process.exit(1)
}
if (res.status !== 0) {
  console.error(`[build:wasm] wasm-pack exited with code ${res.status}`)
  process.exit(res.status ?? 1)
}

// Remove the .gitignore wasm-pack drops into --out-dir (it would ignore the
// served bundle). Also remove the generated package.json's effect is harmless,
// so we leave it; only the .gitignore is problematic.
const gitignore = resolve(outDir, '.gitignore')
if (existsSync(gitignore)) {
  rmSync(gitignore)
  console.log('[build:wasm] removed wasm-pack-generated .gitignore')
}

console.log(`[build:wasm] done -> ${outDir}`)

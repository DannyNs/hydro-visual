// Shared builders + assertions for the solver test suites (tsSolver.test.ts and
// parity.test.ts). NOTE: this is a *test-only* helper module — it is not
// imported by any application code. It deliberately mirrors the shapes produced
// by `store/factory.ts::graphToSolveRequest` (role + flat numeric params per
// node; from/fromPort/to/toPort/line/lengthM/diameterMm per edge) so the
// requests built here exercise the exact contract the app sends to the solver.

import type { SolveRequest, SolveNode, SolveEdge, SolveResult } from './contract'

/** Build a steady-state SolveRequest with the app's default water fluid. */
export function makeRequest(nodes: SolveNode[], edges: SolveEdge[], ambientC = 20): SolveRequest {
  return {
    nodes,
    edges,
    fluid: { cpJkgK: 4186, rhoKgM3: 997 },
    ambientC,
    mode: 'steady',
  }
}

/** Build a SolveNode (role + flat numeric param bag), as factory.ts emits. */
export function node(
  id: string,
  role: SolveNode['role'],
  params: Record<string, number> = {},
): SolveNode {
  return { id, role, params }
}

/** Build a SolveEdge (port-to-port pipe), as factory.ts emits. */
export function edge(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
  line: SolveEdge['line'] = 'auto',
  lengthM = 4,
  diameterMm = 22,
): SolveEdge {
  return { id, from, fromPort, to, toPort, line, lengthM, diameterMm }
}

/**
 * Signed net volumetric flow [m³/h] at every node, derived purely from the
 * solved edge results. Convention: an edge result's `dir` is +1 when fluid runs
 * source→target (`from`→`to`); so `dir*flowM3h` LEAVES `from` (counted −) and
 * ENTERS `to` (counted +). For a mass-conserving solve every node except the
 * hydraulic reference (slack) node must sum to ≈ 0.
 */
export function nodeNetFlows(res: SolveResult, edges: SolveEdge[]): Map<string, number> {
  const net = new Map<string, number>()
  const bump = (id: string, v: number) => net.set(id, (net.get(id) ?? 0) + v)
  for (const e of edges) {
    const er = res.edges[e.id]
    if (!er) continue
    const signed = (er.dir ?? 0) * er.flowM3h
    bump(e.from, -signed) // out of `from`
    bump(e.to, +signed) // into `to`
  }
  return net
}

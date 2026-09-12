import { describe, it, expect } from 'vitest'
import { solve } from './tsSolver'
import type { SolveRequest } from './contract'

// A check valve must pass forward flow (in->out) and block reverse flow.
// Loop: source (built-in pump) -> check valve -> emitter -> back to source.
const base = {
  fluid: { cpJkgK: 4186, rhoKgM3: 997 },
  ambientC: 20,
  mode: 'steady' as const,
}
const nodes: SolveRequest['nodes'] = [
  { id: 's', role: 'source', params: { ratedKw: 8, maxSupplyC: 60, h0Kpa: 40, qMaxM3h: 2 } },
  { id: 'cv', role: 'check', params: { kKpa: 0.3 } },
  { id: 'e', role: 'emitter', params: { ratedKw: 3, ratedExcessC: 45, roomC: 20, exponent: 1.3 } },
]
const pipe = (id: string, from: string, fromPort: string, to: string, toPort: string): SolveRequest['edges'][number] => ({
  id, from, fromPort, to, toPort, line: 'supply', lengthM: 2, diameterMm: 22,
})

describe('check valve directionality', () => {
  it('passes flow when wired forward (in->out with the flow)', () => {
    const req: SolveRequest = {
      ...base,
      nodes,
      edges: [
        pipe('p1', 's', 'sup', 'cv', 'in'),
        pipe('p2', 'cv', 'out', 'e', 'sup'),
        pipe('p3', 'e', 'ret', 's', 'ret'),
      ],
    }
    const r = solve(req)
    expect(r.global.flowM3h).toBeGreaterThan(0.1)
    expect(r.edges['p2'].flowM3h).toBeGreaterThan(0.1)
  })

  it('blocks flow when wired against it (flow would run out->in)', () => {
    const req: SolveRequest = {
      ...base,
      nodes,
      edges: [
        pipe('p1', 's', 'sup', 'cv', 'out'), // enters the valve at its OUTLET = reverse
        pipe('p2', 'cv', 'in', 'e', 'sup'),
        pipe('p3', 'e', 'ret', 's', 'ret'),
      ],
    }
    const r = solve(req)
    // reverse path is shut, so the loop carries essentially no flow
    expect(r.global.flowM3h).toBeLessThan(0.02)
    expect(Math.abs(r.edges['p2'].flowM3h)).toBeLessThan(0.02)
  })
})

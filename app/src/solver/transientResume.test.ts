import { describe, it, expect } from 'vitest'
import { solveTransient } from './transient'
import { makeNode, makeEdge, type RFNode } from '../store/factory'
import { graphToSolveRequest } from '../store/factory'
import type { SolveRequest } from './contract'

// Charge-up must REACT to mid-run edits: re-solving from the current warm tank
// state (not cold) so a switched-off heater stops the buffer rising. These guard
// the resume path (initialTankTemps). Self-contained buffered loop (a heat pump
// charges a buffer; a circulator drives a radiator off it) so the test is
// independent of whatever the seed topology happens to be.
function buffered(hpEnabled = true): { nodes: RFNode[]; req: (over?: Partial<SolveRequest['transient']>) => SolveRequest } {
  const hp = makeNode('heat_pump', 0, 0, { ratedKw: 14, maxSupplyC: 60, h0Kpa: 45, qMaxM3h: 2.4 }, 'hp')
  if (!hpEnabled) hp.data.enabled = false
  const buf = makeNode('buffer_tank', 0, 0, { volumeL: 300, entriesPerSide: 2 }, 'buf')
  const circ = makeNode('circulator', 0, 0, { h0Kpa: 30, qMaxM3h: 1.4 }, 'circ')
  const rad = makeNode('radiator', 0, 0, { ratedKw: 3, ratedExcessC: 45 }, 'rad')
  const nodes = [hp, buf, circ, rad]
  const edges = [
    makeEdge('hp', 'sup', 'buf', 'l0', 'supply', 4, 28),
    makeEdge('buf', 'l1', 'hp', 'ret', 'return', 4, 28),
    makeEdge('buf', 'r0', 'circ', 'in', 'supply', 4, 22),
    makeEdge('circ', 'out', 'rad', 'sup', 'supply', 4, 22),
    makeEdge('rad', 'ret', 'buf', 'r1', 'return', 4, 22),
  ]
  return {
    nodes,
    req: (over) => {
      const r = graphToSolveRequest(nodes, edges)
      r.mode = 'transient'
      r.transient = { durationS: 10800, frameCount: 60, layers: 10, ...over }
      return r
    },
  }
}

describe('transient resume (mid-run edits take effect)', () => {
  // charge the buffer fully, capture its warm layer temps
  const cold = solveTransient(buffered().req())
  const warm = cold.frames[cold.frames.length - 1].tankTemps?.buf
  it('cold start charges the buffer hot (sanity)', () => {
    expect(warm).toBeTruthy()
    expect((warm as number[])[0]).toBeGreaterThan(40)
  })

  it('resumes from the seeded warm state instead of cold ambient', () => {
    const resumed = solveTransient(buffered().req({ initialTankTemps: { buf: warm as number[] } }))
    const startTop = resumed.frames[0].tankTemps?.buf?.[0] ?? 0
    expect(startTop).toBeGreaterThan(40) // starts warm, not at the 20 °C cold fill
    expect(startTop).toBeCloseTo((warm as number[])[0], 0)
  })

  it('heater OFF stops the buffer rising (it holds/cools as the load draws it)', () => {
    const r = solveTransient(buffered(false).req({ durationS: 3600, frameCount: 30, initialTankTemps: { buf: warm as number[] } }))
    const startTop = r.frames[0].tankTemps?.buf?.[0] ?? 0
    const endTop = r.frames[r.frames.length - 1].tankTemps?.buf?.[0] ?? 0
    expect(endTop).toBeLessThanOrEqual(startTop + 0.5) // must NOT keep climbing
  })

  it('heater ON keeps charging from a partially-warm state (still rises)', () => {
    const lukewarm = new Array(10).fill(30)
    const r = solveTransient(buffered().req({ initialTankTemps: { buf: lukewarm } }))
    const startTop = r.frames[0].tankTemps?.buf?.[0] ?? 0
    const endTop = r.frames[r.frames.length - 1].tankTemps?.buf?.[0] ?? 0
    expect(endTop).toBeGreaterThan(startTop + 2)
  })
})

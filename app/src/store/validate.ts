import type { RFNode, RFEdge } from './factory'
import { CATALOG } from '../model/catalog'
import type { SolveResult } from '../solver/contract'

// Lightweight design sanity checks surfaced to the user (NOT a hard gate — the
// solver still runs). Catches the common "why won't it work" mistakes. Warnings
// carry an i18n key (+ vars) so the banner can localise them at render time.
export interface GraphWarning {
  level: 'warn' | 'error'
  key: string
  vars?: Record<string, string | number>
  nodeId?: string
  nodeIds?: string[]
}

export function validateGraph(nodes: RFNode[], edges: RFEdge[]): GraphWarning[] {
  const w: GraphWarning[] = []
  if (nodes.length === 0) return w

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const label = (n: RFNode) => n.data.label || CATALOG[n.data.kind]?.label || n.data.kind
  const roleOf = (n: RFNode) => CATALOG[n.data.kind]?.role

  // disconnected components
  for (const n of nodes) {
    if (!degree.get(n.id))
      w.push({ level: 'warn', key: 'warn.disconnected', vars: { name: label(n) }, nodeId: n.id })
  }

  // nothing drives flow (no ENABLED pump / pump-group / heat source with a
  // built-in pump — a switched-off circulator doesn't circulate)
  const hasDriver = nodes.some(isActiveDriver)
  if (!hasDriver) w.push({ level: 'error', key: 'warn.noDriver' })

  // a source with no place to put the heat
  const roles = new Set(nodes.map(roleOf))
  if (roles.has('source') && !roles.has('emitter') && !roles.has('tank'))
    w.push({ level: 'warn', key: 'warn.sourceNoLoad' })
  if ((roles.has('emitter') || roles.has('group')) && !roles.has('source'))
    w.push({ level: 'warn', key: 'warn.loadNoSource' })

  return w
}

// An enabled flow driver: a pump, a pump group, or a heat source with a built-in
// circulator (h0Kpa). Switched-off devices don't drive flow.
function isActiveDriver(n: RFNode): boolean {
  if (n.data.enabled === false) return false
  const role = CATALOG[n.data.kind]?.role
  if (role === 'pump' || role === 'group') return true
  return role === 'source' && n.data.params.h0Kpa !== undefined
}

// Checks that need the SOLVED result (flow + pressure), merged with the static
// warnings after each solve. Surfaces the two faults the design checks can't see
// from topology alone: pumps fighting each other, and out-of-band pressure.
// The port each active driver pushes fluid OUT of (its pump discharge):
// 'out' for pumps, 'sup' for sources with a built-in circulator, 'sec_out'
// for pump groups. Fluid ENTERING this port means the driver is being
// back-driven by another pump — the real signature of a fight.
function pushOutPort(n: RFNode): string | null {
  const role = CATALOG[n.data.kind]?.role
  if (role === 'pump') return 'out'
  if (role === 'source' && n.data.params.h0Kpa !== undefined) return 'sup'
  if (role === 'group') return 'sec_out'
  return null
}

// Net flow [m³/h] ENTERING a node port from its connected pipes, per the solved
// edge directions (dir +1 = along drawn source->target).
function portInflowM3h(nodeId: string, port: string, edges: RFEdge[], res: SolveResult): number {
  let inflow = 0
  for (const e of edges) {
    const r = res.edges[e.id]
    if (!r || !r.dir) continue
    if (e.source === nodeId && e.sourceHandle === port) inflow -= r.dir * r.flowM3h
    else if (e.target === nodeId && e.targetHandle === port) inflow += r.dir * r.flowM3h
  }
  return inflow
}

export function resultWarnings(nodes: RFNode[], edges: RFEdge[], res: SolveResult): GraphWarning[] {
  const w: GraphWarning[] = []
  if (nodes.length === 0) return w
  const global = res.global

  // Pumps fighting: two or more pumps are running yet almost nothing moves — the
  // classic opposed / dead-headed signature (a single pump pushing against a shut
  // valve just reads as no-flow, not a fight, so this needs >= 2 drivers).
  // Judge on REAL pipe flow, not global.flowM3h: that metric is derived from
  // heat-source throughput only and reads 0 in any system without a source,
  // which would false-flag e.g. two pumps on opposite sides of a hydraulic
  // separator (they can't fight — the separator decouples them).
  const maxPipeFlow = Object.values(res.edges).reduce((m, e) => Math.max(m, e.flowM3h), 0)
  const drivers = nodes.filter(isActiveDriver)
  // The near-zero-flow check alone misses ASYMMETRIC fights: when one pump is
  // stronger the solver settles at an equilibrium where fluid is pushed BACKWARDS
  // through the weaker one, so real pipe flow stays well above zero. Catch that
  // with a per-driver back-drive signature instead.
  const BACK_DRIVE_M3H = 0.05
  const backDriven = drivers.filter((n) => {
    const port = pushOutPort(n)
    return port !== null && portInflowM3h(n.id, port, edges, res) > BACK_DRIVE_M3H
  })
  if (
    drivers.length >= 2 &&
    global.pressureKpa > 0 &&
    (maxPipeFlow < 0.02 || backDriven.length > 0)
  ) {
    // name the culprits so the user knows which pumps to check, and hand their
    // ids to the canvas for highlighting. When a back-driven pump was found,
    // restrict to drivers in its pipe-connected component(s); otherwise (pure
    // dead-head) all drivers are involved.
    let involved = drivers
    if (backDriven.length > 0) {
      const adj = new Map<string, string[]>()
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, [])
        if (!adj.has(e.target)) adj.set(e.target, [])
        adj.get(e.source)!.push(e.target)
        adj.get(e.target)!.push(e.source)
      }
      const comp = new Set<string>()
      for (const b of backDriven) {
        const stack = [b.id]
        while (stack.length) {
          const id = stack.pop()!
          if (comp.has(id)) continue
          comp.add(id)
          for (const nb of adj.get(id) ?? []) if (!comp.has(nb)) stack.push(nb)
        }
      }
      involved = drivers.filter((n) => comp.has(n.id))
    }
    const names = involved
      .map((n) => n.data.label || CATALOG[n.data.kind]?.label || n.data.kind)
      .join(', ')
    w.push({
      level: 'warn',
      key: 'warn.pumpsFighting',
      vars: { names },
      nodeIds: involved.map((n) => n.id),
    })
  }

  // Pressure out of the safe operating band. The relief setpoint comes from a
  // pressure_relief valve if placed, else the usual 3 bar default.
  const reliefBars = nodes
    .filter((n) => n.data.kind === 'pressure_relief')
    .map((n) => n.data.params.setBar ?? 3)
  // lowest placed relief valve wins; 3 bar is only the no-valve fallback
  const reliefBar = reliefBars.length ? Math.min(...reliefBars) : 3
  const bar = global.pressureKpa / 100
  if (global.pressureKpa > 0 && bar >= reliefBar)
    w.push({ level: 'warn', key: 'warn.pressureHigh', vars: { bar: bar.toFixed(1) } })
  else if (global.pressureKpa > 0 && bar < 0.8)
    w.push({ level: 'warn', key: 'warn.pressureLow', vars: { bar: bar.toFixed(1) } })

  return w
}

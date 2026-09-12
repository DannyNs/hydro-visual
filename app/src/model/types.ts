// Domain model for the hydronic designer.
// A system is a graph: component nodes connected by pipe edges.

export type Category =
  | 'heat-sources'
  | 'pumps'
  | 'pump-groups'
  | 'emitters'
  | 'tanks'
  | 'separators'
  | 'manifolds'
  | 'pipes'
  | 'valves'
  | 'safety'
  | 'sensors'
  | 'controllers'

export type ComponentKind =
  // heat sources
  | 'heat_pump'
  | 'gas_boiler'
  | 'oil_boiler'
  | 'biomass_boiler'
  | 'electric_boiler'
  | 'solar_thermal'
  | 'district_heating'
  // pumps
  | 'circulator'
  | 'variable_speed_pump'
  // pump groups
  | 'direct_group'
  | 'mixing_group'
  | 'injection_group'
  // emitters
  | 'radiator'
  | 'underfloor'
  | 'fan_coil'
  | 'towel_rail'
  | 'air_handler'
  // tanks
  | 'buffer_tank'
  | 'dhw_cylinder'
  | 'combi_cylinder'
  | 'thermal_store'
  // separators / manifolds
  | 'hydraulic_separator'
  | 'low_loss_header'
  | 'manifold'
  | 'ufh_manifold'
  // valves
  | 'mixing_valve'
  | 'diverter_valve'
  | 'zone_valve'
  | 'thermostatic_valve'
  | 'balancing_valve'
  | 'check_valve'
  // safety
  | 'expansion_vessel'
  | 'dirt_separator'
  | 'air_vent'
  | 'fill_valve'
  | 'pressure_relief'
  | 'strainer'
  // sensors & meters
  | 'sensor'
  | 'flow_meter'
  | 'heat_meter'
  | 'pressure_gauge'
  // controllers
  | 'weather_compensator'
  | 'zone_controller'
  // pipes & fittings
  | 'tee'
  | 'cross'
  | 'elbow'
  | 'reducer'

// How the physics solver treats a component.
export type SolverRole =
  | 'source' // adds heat to the fluid (boiler, heat pump)
  | 'pump' // raises pressure, drives flow
  | 'group' // pump group: 4-port primary/secondary set with a pump (+ optional mix)
  | 'emitter' // removes heat to a room
  | 'tank' // storage / mixing node
  | 'junction' // hydraulic mixing junction (separator, low-loss header, tee, cross)
  | 'manifold' // split junction: supply rail + return rail kept separate (no mixing)
  | 'valve' // blends supply + return toward a target temp
  | 'check' // one-way: passes forward (in→out), blocks reverse flow
  | 'passive' // small resistance, no thermal effect

export type PortSide = 'left' | 'right' | 'top' | 'bottom'

export interface Port {
  id: string
  label?: string
  side: PortSide
  /** position along the side, 0..1 */
  offset: number
  /** hint used for auto pipe coloring */
  hint?: 'supply' | 'return'
}

export interface ParamSpec {
  key: string
  label: string
  unit: string
  default: number
  min?: number
  max?: number
  step?: number
}

// ---- runtime graph (mirrors the Redux store) ----

/** Data attached to a React Flow node. */
export interface CompNodeData {
  kind: ComponentKind
  label: string
  params: Record<string, number>
  /** powered devices (sources, pumps, groups, zone valves) can be switched off;
   *  undefined/true = on. An off device adds no heat and drives no flow. */
  enabled?: boolean
  /** populated after a solve, used to color/label the node */
  result?: NodeResult
  [key: string]: unknown
}

/** Data attached to a React Flow edge (a pipe). */
export interface PipeEdgeData {
  line: 'supply' | 'return' | 'auto'
  lengthM: number
  /** user typed the length by hand — auto length sync leaves it alone */
  lengthManual?: boolean
  diameterMm: number
  result?: EdgeResult
  [key: string]: unknown
}

// ---- solver result fragments (shared with contract.ts) ----

export interface EdgeResult {
  flowM3h: number
  tempC: number
  line: 'supply' | 'return'
  /** flow direction along the drawn edge: +1 source→target, -1 reverse, 0 none */
  dir?: number
}

export interface NodeResult {
  heatKw?: number
  supplyC?: number
  returnC?: number
  valvePct?: number
  cop?: number
  /** top→bottom temperature layers for stratified tanks */
  strat?: number[]
}

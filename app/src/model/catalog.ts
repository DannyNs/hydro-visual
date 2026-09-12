import type {
  Category,
  ComponentKind,
  ParamSpec,
  Port,
  SolverRole,
} from './types'

export interface ComponentDef {
  kind: ComponentKind
  category: Category
  label: string
  role: SolverRole
  size: { w: number; h: number }
  params: ParamSpec[]
  /** default/static ports (used when dynamicPorts is absent) */
  ports: Port[]
  /** when present, ports are generated per-instance from its params (e.g. a
   *  configurable number of tank tappings or manifold circuits) */
  dynamicPorts?: (params: Record<string, number>) => Port[]
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)))

// Two-sided tappings (buffer tanks, hydraulic separators / low-loss headers):
// `entriesPerSide` ports down each side, top half supply, bottom half return.
// Ids l0..l{n-1} / r0..r{n-1} are stable as the count grows, so existing wiring
// survives an increase.
function tappingPorts(params: Record<string, number>): Port[] {
  const k = clampInt(params.entriesPerSide ?? 2, 2, 6)
  const ports: Port[] = []
  for (let i = 0; i < k; i++) {
    const offset = 0.12 + (i / Math.max(k - 1, 1)) * 0.76
    const hint: Port['hint'] = i < k / 2 ? 'supply' : 'return'
    ports.push({ id: `l${i}`, side: 'left', offset, hint })
    ports.push({ id: `r${i}`, side: 'right', offset, hint })
  }
  return ports
}

// Manifold: a supply-in / return-out on the left, then `circuits` supply+return
// pairs on the right (sup0/ret0 …). Stable ids as the count grows.
function manifoldPorts(params: Record<string, number>): Port[] {
  const n = clampInt(params.circuits ?? 2, 1, 10)
  const ports: Port[] = [
    { id: 'sup_in', side: 'left', offset: 0.32, hint: 'supply' },
    { id: 'ret_out', side: 'left', offset: 0.72, hint: 'return' },
  ]
  for (let i = 0; i < n; i++) {
    const base = 0.1 + (i / Math.max(n, 1)) * 0.86
    ports.push({ id: `sup${i}`, side: 'right', offset: base, hint: 'supply' })
    ports.push({ id: `ret${i}`, side: 'right', offset: base + 0.42 / n, hint: 'return' })
  }
  return ports
}

// ---- reusable port layouts ----

const sourcePorts: Port[] = [
  { id: 'sup', label: 'Supply', side: 'right', offset: 0.3, hint: 'supply' },
  { id: 'ret', label: 'Return', side: 'right', offset: 0.72, hint: 'return' },
]
const emitterPorts: Port[] = [
  { id: 'sup', label: 'Supply', side: 'left', offset: 0.3, hint: 'supply' },
  { id: 'ret', label: 'Return', side: 'left', offset: 0.72, hint: 'return' },
]
const inlinePorts: Port[] = [
  { id: 'in', side: 'left', offset: 0.5 },
  { id: 'out', side: 'right', offset: 0.5 },
]
const tapPort: Port[] = [{ id: 'tap', side: 'top', offset: 0.5 }]

const valvePorts: Port[] = [
  { id: 'hot', label: 'Hot', side: 'left', offset: 0.28, hint: 'supply' },
  { id: 'cold', label: 'Cold', side: 'left', offset: 0.74, hint: 'return' },
  { id: 'mix', label: 'Mixed', side: 'right', offset: 0.5, hint: 'supply' },
]

// Pump groups: primary side (left) connects to the source/buffer, secondary
// side (right) serves the load. Top = hot, bottom = cool.
const groupPorts: Port[] = [
  { id: 'pri_in', label: 'Primary supply', side: 'left', offset: 0.28, hint: 'supply' },
  { id: 'pri_out', label: 'Primary return', side: 'left', offset: 0.74, hint: 'return' },
  { id: 'sec_out', label: 'To load', side: 'right', offset: 0.28, hint: 'supply' },
  { id: 'sec_in', label: 'From load', side: 'right', offset: 0.74, hint: 'return' },
]

const p = (
  key: string,
  label: string,
  unit: string,
  def: number,
  min?: number,
  max?: number,
  step?: number,
): ParamSpec => ({ key, label, unit, default: def, min, max, step })

export const CATALOG: Record<ComponentKind, ComponentDef> = {
  heat_pump: {
    kind: 'heat_pump',
    category: 'heat-sources',
    label: 'Air Source Heat Pump',
    role: 'source',
    size: { w: 132, h: 104 },
    ports: sourcePorts,
    params: [
      p('ratedKw', 'Rated output', 'kW', 12, 2, 60, 0.5),
      p('maxSupplyC', 'Max supply', '°C', 55, 35, 75, 1),
      p('sourceC', 'Source (air)', '°C', 7, -20, 35, 1),
      p('copRated', 'Rated COP', '', 4.2, 1.5, 6, 0.1),
      p('h0Kpa', 'Pump head', 'kPa', 45, 5, 120, 1),
      p('qMaxM3h', 'Pump max flow', 'm³/h', 2.6, 0.2, 20, 0.1),
    ],
  },
  gas_boiler: {
    kind: 'gas_boiler',
    category: 'heat-sources',
    label: 'Gas Boiler',
    role: 'source',
    size: { w: 96, h: 116 },
    ports: sourcePorts,
    params: [
      p('ratedKw', 'Rated output', 'kW', 24, 4, 120, 1),
      p('maxSupplyC', 'Max supply', '°C', 75, 50, 90, 1),
      p('efficiency', 'Efficiency', '', 0.95, 0.6, 1.09, 0.01),
      p('h0Kpa', 'Pump head', 'kPa', 40, 5, 120, 1),
      p('qMaxM3h', 'Pump max flow', 'm³/h', 2.2, 0.2, 20, 0.1),
    ],
  },
  circulator: {
    kind: 'circulator',
    category: 'pumps',
    label: 'Circulator Pump',
    role: 'pump',
    size: { w: 70, h: 70 },
    ports: inlinePorts,
    params: [
      p('h0Kpa', 'Shutoff head', 'kPa', 45, 5, 120, 1),
      p('qMaxM3h', 'Max flow', 'm³/h', 3.5, 0.2, 20, 0.1),
    ],
  },
  direct_group: {
    kind: 'direct_group',
    category: 'pump-groups',
    label: 'Direct Pump Group',
    role: 'group',
    size: { w: 110, h: 100 },
    ports: groupPorts,
    params: [
      p('h0Kpa', 'Shutoff head', 'kPa', 50, 5, 120, 1),
      p('qMaxM3h', 'Max flow', 'm³/h', 3.0, 0.2, 20, 0.1),
    ],
  },
  mixing_group: {
    kind: 'mixing_group',
    category: 'pump-groups',
    label: 'Mixing Pump Group',
    role: 'group',
    size: { w: 110, h: 100 },
    ports: groupPorts,
    params: [
      p('h0Kpa', 'Shutoff head', 'kPa', 50, 5, 120, 1),
      p('qMaxM3h', 'Max flow', 'm³/h', 3.0, 0.2, 20, 0.1),
      p('targetSupplyC', 'Mix target', '°C', 40, 20, 70, 1),
    ],
  },
  radiator: {
    kind: 'radiator',
    category: 'emitters',
    label: 'Radiator',
    role: 'emitter',
    size: { w: 104, h: 84 },
    ports: emitterPorts,
    params: [
      p('ratedKw', 'Rated output', 'kW', 2.0, 0.1, 12, 0.1),
      p('ratedExcessC', 'Rated Δt excess', 'K', 50, 20, 60, 1),
      p('roomC', 'Room temp', '°C', 20, 5, 30, 0.5),
      p('exponent', 'Emitter exp n', '', 1.3, 1.0, 1.5, 0.01),
    ],
  },
  underfloor: {
    kind: 'underfloor',
    category: 'emitters',
    label: 'Underfloor Heating',
    role: 'emitter',
    size: { w: 118, h: 80 },
    ports: emitterPorts,
    params: [
      p('ratedKw', 'Rated output', 'kW', 4.0, 0.2, 16, 0.1),
      p('ratedExcessC', 'Rated Δt excess', 'K', 15, 8, 30, 1),
      p('roomC', 'Room temp', '°C', 21, 5, 30, 0.5),
      p('exponent', 'Emitter exp n', '', 1.1, 1.0, 1.3, 0.01),
    ],
  },
  buffer_tank: {
    kind: 'buffer_tank',
    category: 'tanks',
    label: 'Buffer Tank',
    role: 'tank',
    size: { w: 84, h: 134 },
    ports: tappingPorts({ entriesPerSide: 2 }),
    dynamicPorts: tappingPorts,
    params: [
      p('entriesPerSide', 'Tappings / side', '', 2, 2, 6, 1),
      p('volumeL', 'Volume', 'L', 500, 50, 2000, 10),
      p('heightM', 'Height', 'm', 1.4, 0.6, 2.4, 0.1),
    ],
  },
  dhw_cylinder: {
    kind: 'dhw_cylinder',
    category: 'tanks',
    label: 'DHW Cylinder',
    role: 'tank',
    size: { w: 76, h: 128 },
    ports: emitterPorts,
    params: [
      p('volumeL', 'Volume', 'L', 200, 80, 500, 10),
      p('setpointC', 'DHW setpoint', '°C', 50, 40, 65, 1),
      p('standbyKw', 'Standby load', 'kW', 0.4, 0, 6, 0.1),
    ],
  },
  hydraulic_separator: {
    kind: 'hydraulic_separator',
    category: 'separators',
    label: 'Hydraulic Separator',
    role: 'junction',
    size: { w: 66, h: 124 },
    ports: tappingPorts({ entriesPerSide: 2 }),
    dynamicPorts: tappingPorts,
    params: [
      p('entriesPerSide', 'Connections / side', '', 2, 2, 6, 1),
      p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.5, 0, 20, 0.1),
    ],
  },
  manifold: {
    kind: 'manifold',
    category: 'manifolds',
    role: 'manifold',
    label: 'Manifold',
    size: { w: 96, h: 78 },
    ports: manifoldPorts({ circuits: 2 }),
    dynamicPorts: manifoldPorts,
    params: [p('circuits', 'Circuits', '', 2, 1, 10, 1)],
  },
  mixing_valve: {
    kind: 'mixing_valve',
    category: 'valves',
    label: '3-Way Mixing Valve',
    role: 'valve',
    size: { w: 64, h: 64 },
    ports: valvePorts,
    params: [
      p('targetC', 'Target temp', '°C', 40, 20, 70, 1),
      p('authority', 'Authority', '', 0.5, 0.1, 1, 0.05),
    ],
  },
  expansion_vessel: {
    kind: 'expansion_vessel',
    category: 'safety',
    label: 'Expansion Vessel',
    role: 'passive',
    size: { w: 52, h: 76 },
    ports: tapPort,
    params: [
      p('volumeL', 'Volume', 'L', 18, 2, 200, 1),
      p('prechargeBar', 'Precharge', 'bar', 1.0, 0.5, 4, 0.1),
    ],
  },
  dirt_separator: {
    kind: 'dirt_separator',
    category: 'safety',
    label: 'Dirt Separator',
    role: 'passive',
    size: { w: 54, h: 76 },
    ports: inlinePorts,
    params: [p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.4, 0, 10, 0.1)],
  },
  air_vent: {
    kind: 'air_vent',
    category: 'safety',
    label: 'Automatic Air Vent',
    role: 'passive',
    size: { w: 40, h: 60 },
    ports: tapPort,
    params: [],
  },
  fill_valve: {
    kind: 'fill_valve',
    category: 'safety',
    label: 'Fill Valve',
    role: 'passive',
    size: { w: 52, h: 56 },
    ports: inlinePorts,
    params: [p('setBar', 'Fill pressure', 'bar', 1.5, 0.5, 3, 0.1)],
  },
  sensor: {
    kind: 'sensor',
    category: 'sensors',
    label: 'Temperature Sensor',
    role: 'passive',
    size: { w: 38, h: 38 },
    ports: tapPort,
    params: [],
  },

  // ---- heat sources ----
  oil_boiler: {
    kind: 'oil_boiler', category: 'heat-sources', label: 'Oil Boiler', role: 'source',
    size: { w: 96, h: 116 }, ports: sourcePorts,
    params: [p('ratedKw', 'Rated output', 'kW', 26, 6, 120, 1), p('maxSupplyC', 'Max supply', '°C', 75, 50, 90, 1), p('efficiency', 'Efficiency', '', 0.9, 0.6, 1, 0.01), p('h0Kpa', 'Pump head', 'kPa', 40, 5, 120, 1), p('qMaxM3h', 'Pump max flow', 'm³/h', 2.4, 0.2, 20, 0.1)],
  },
  biomass_boiler: {
    kind: 'biomass_boiler', category: 'heat-sources', label: 'Biomass Boiler', role: 'source',
    size: { w: 106, h: 120 }, ports: sourcePorts,
    params: [p('ratedKw', 'Rated output', 'kW', 20, 5, 150, 1), p('maxSupplyC', 'Max supply', '°C', 80, 50, 90, 1), p('efficiency', 'Efficiency', '', 0.85, 0.6, 1, 0.01), p('h0Kpa', 'Pump head', 'kPa', 45, 5, 120, 1), p('qMaxM3h', 'Pump max flow', 'm³/h', 2.4, 0.2, 20, 0.1)],
  },
  electric_boiler: {
    kind: 'electric_boiler', category: 'heat-sources', label: 'Electric Boiler', role: 'source',
    size: { w: 84, h: 108 }, ports: sourcePorts,
    params: [p('ratedKw', 'Rated output', 'kW', 9, 1, 48, 0.5), p('maxSupplyC', 'Max supply', '°C', 70, 40, 85, 1), p('efficiency', 'Efficiency', '', 0.99, 0.9, 1, 0.01), p('h0Kpa', 'Pump head', 'kPa', 35, 5, 120, 1), p('qMaxM3h', 'Pump max flow', 'm³/h', 1.8, 0.2, 20, 0.1)],
  },
  solar_thermal: {
    kind: 'solar_thermal', category: 'heat-sources', label: 'Solar Thermal', role: 'source',
    size: { w: 122, h: 84 }, ports: sourcePorts,
    params: [p('ratedKw', 'Collector output', 'kW', 4, 0.5, 20, 0.5), p('maxSupplyC', 'Max supply', '°C', 65, 40, 95, 1), p('sourceC', 'Irradiance temp', '°C', 25, 0, 60, 1)],
  },
  district_heating: {
    kind: 'district_heating', category: 'heat-sources', label: 'District Heating', role: 'source',
    size: { w: 96, h: 100 }, ports: sourcePorts,
    params: [p('ratedKw', 'Capacity', 'kW', 40, 5, 300, 5), p('maxSupplyC', 'Supply temp', '°C', 70, 50, 95, 1), p('h0Kpa', 'Pump head', 'kPa', 45, 5, 120, 1), p('qMaxM3h', 'Pump max flow', 'm³/h', 3, 0.2, 20, 0.1)],
  },

  // ---- pumps ----
  variable_speed_pump: {
    kind: 'variable_speed_pump', category: 'pumps', label: 'Variable-Speed Pump', role: 'pump',
    size: { w: 72, h: 72 }, ports: inlinePorts,
    params: [p('h0Kpa', 'Shutoff head', 'kPa', 60, 5, 140, 1), p('qMaxM3h', 'Max flow', 'm³/h', 4, 0.2, 24, 0.1)],
  },

  // ---- pump groups ----
  injection_group: {
    kind: 'injection_group', category: 'pump-groups', label: 'Injection Pump Group', role: 'group',
    size: { w: 110, h: 100 }, ports: groupPorts,
    params: [p('h0Kpa', 'Shutoff head', 'kPa', 55, 5, 120, 1), p('qMaxM3h', 'Max flow', 'm³/h', 2.5, 0.2, 20, 0.1), p('targetSupplyC', 'Mix target', '°C', 40, 20, 70, 1)],
  },

  // ---- emitters ----
  fan_coil: {
    kind: 'fan_coil', category: 'emitters', label: 'Fan Coil Unit', role: 'emitter',
    size: { w: 106, h: 82 }, ports: emitterPorts,
    params: [p('ratedKw', 'Rated output', 'kW', 5, 0.5, 30, 0.5), p('ratedExcessC', 'Rated Δt excess', 'K', 40, 15, 60, 1), p('roomC', 'Room temp', '°C', 22, 5, 30, 0.5), p('exponent', 'Emitter exp n', '', 1.0, 1.0, 1.4, 0.01)],
  },
  towel_rail: {
    kind: 'towel_rail', category: 'emitters', label: 'Heated Towel Rail', role: 'emitter',
    size: { w: 60, h: 96 }, ports: emitterPorts,
    params: [p('ratedKw', 'Rated output', 'kW', 0.5, 0.1, 2, 0.1), p('ratedExcessC', 'Rated Δt excess', 'K', 50, 20, 60, 1), p('roomC', 'Room temp', '°C', 22, 5, 30, 0.5), p('exponent', 'Emitter exp n', '', 1.3, 1.0, 1.5, 0.01)],
  },
  air_handler: {
    kind: 'air_handler', category: 'emitters', label: 'Air Handling Unit', role: 'emitter',
    size: { w: 122, h: 92 }, ports: emitterPorts,
    params: [p('ratedKw', 'Rated output', 'kW', 12, 1, 80, 1), p('ratedExcessC', 'Rated Δt excess', 'K', 30, 10, 50, 1), p('roomC', 'Air temp', '°C', 20, 5, 30, 0.5), p('exponent', 'Emitter exp n', '', 1.0, 1.0, 1.3, 0.01)],
  },

  // ---- tanks ----
  combi_cylinder: {
    kind: 'combi_cylinder', category: 'tanks', label: 'Combi Cylinder', role: 'tank',
    size: { w: 80, h: 134 }, ports: emitterPorts,
    params: [p('volumeL', 'Volume', 'L', 250, 80, 600, 10), p('setpointC', 'DHW setpoint', '°C', 55, 40, 65, 1), p('standbyKw', 'DHW load', 'kW', 3, 0, 12, 0.1)],
  },
  thermal_store: {
    kind: 'thermal_store', category: 'tanks', label: 'Thermal Store', role: 'tank',
    size: { w: 88, h: 140 }, ports: tappingPorts({ entriesPerSide: 2 }), dynamicPorts: tappingPorts,
    params: [p('entriesPerSide', 'Tappings / side', '', 2, 2, 6, 1), p('volumeL', 'Volume', 'L', 1000, 100, 5000, 50), p('heightM', 'Height', 'm', 1.8, 0.8, 2.6, 0.1)],
  },

  // ---- separators / manifolds ----
  low_loss_header: {
    kind: 'low_loss_header', category: 'separators', label: 'Low-Loss Header', role: 'junction',
    size: { w: 60, h: 122 }, ports: tappingPorts({ entriesPerSide: 2 }), dynamicPorts: tappingPorts,
    params: [p('entriesPerSide', 'Connections / side', '', 2, 2, 6, 1), p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.3, 0, 20, 0.1)],
  },
  ufh_manifold: {
    kind: 'ufh_manifold', category: 'manifolds', label: 'Underfloor Manifold', role: 'manifold',
    size: { w: 104, h: 80 }, ports: manifoldPorts({ circuits: 4 }), dynamicPorts: manifoldPorts,
    params: [p('circuits', 'Circuits', '', 4, 1, 12, 1)],
  },

  // ---- valves ----
  diverter_valve: {
    kind: 'diverter_valve', category: 'valves', label: '3-Way Diverter', role: 'valve',
    size: { w: 64, h: 64 }, ports: valvePorts,
    params: [p('targetC', 'Target temp', '°C', 45, 20, 75, 1), p('authority', 'Authority', '', 0.5, 0.1, 1, 0.05)],
  },
  zone_valve: {
    kind: 'zone_valve', category: 'valves', label: 'Zone Valve', role: 'passive',
    size: { w: 56, h: 52 }, ports: inlinePorts,
    params: [p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.5, 0, 10, 0.1)],
  },
  thermostatic_valve: {
    kind: 'thermostatic_valve', category: 'valves', label: 'Thermostatic Valve', role: 'passive',
    size: { w: 48, h: 58 }, ports: inlinePorts,
    params: [p('setpointC', 'Room setpoint', '°C', 21, 5, 28, 0.5), p('kKpa', 'Resistance', 'kPa·h²/m⁶', 1, 0, 10, 0.1)],
  },
  balancing_valve: {
    kind: 'balancing_valve', category: 'valves', label: 'Balancing Valve', role: 'passive',
    size: { w: 54, h: 52 }, ports: inlinePorts,
    params: [p('kKpa', 'Resistance', 'kPa·h²/m⁶', 2, 0, 20, 0.1)],
  },
  check_valve: {
    kind: 'check_valve', category: 'valves', label: 'Check Valve', role: 'check',
    size: { w: 54, h: 46 }, ports: inlinePorts,
    params: [p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.3, 0, 10, 0.1)],
  },

  // ---- safety ----
  pressure_relief: {
    kind: 'pressure_relief', category: 'safety', label: 'Pressure Relief Valve', role: 'passive',
    size: { w: 52, h: 62 }, ports: tapPort,
    params: [p('setBar', 'Relief pressure', 'bar', 3, 1, 6, 0.1)],
  },
  strainer: {
    kind: 'strainer', category: 'safety', label: 'Y-Strainer', role: 'passive',
    size: { w: 56, h: 56 }, ports: inlinePorts,
    params: [p('kKpa', 'Resistance', 'kPa·h²/m⁶', 0.5, 0, 10, 0.1)],
  },

  // ---- sensors & meters ----
  flow_meter: {
    kind: 'flow_meter', category: 'sensors', label: 'Flow Meter', role: 'passive',
    size: { w: 46, h: 44 }, ports: inlinePorts, params: [],
  },
  heat_meter: {
    kind: 'heat_meter', category: 'sensors', label: 'Heat Meter', role: 'passive',
    size: { w: 54, h: 46 }, ports: inlinePorts, params: [],
  },
  pressure_gauge: {
    kind: 'pressure_gauge', category: 'sensors', label: 'Pressure Gauge', role: 'passive',
    size: { w: 42, h: 42 }, ports: tapPort, params: [],
  },

  // ---- controllers ----
  weather_compensator: {
    kind: 'weather_compensator', category: 'controllers', label: 'Weather Compensator', role: 'passive',
    size: { w: 66, h: 48 }, ports: tapPort, params: [],
  },
  zone_controller: {
    kind: 'zone_controller', category: 'controllers', label: 'Zone Controller', role: 'passive',
    size: { w: 62, h: 46 }, ports: tapPort, params: [],
  },

  // ---- pipes & fittings ----
  tee: {
    kind: 'tee', category: 'pipes', label: 'Tee', role: 'junction',
    size: { w: 46, h: 46 },
    ports: [
      { id: 'a', side: 'left', offset: 0.4 },
      { id: 'b', side: 'right', offset: 0.4 },
      { id: 'c', side: 'bottom', offset: 0.5 },
    ],
    params: [],
  },
  cross: {
    kind: 'cross', category: 'pipes', label: 'Cross', role: 'junction',
    size: { w: 46, h: 46 },
    ports: [
      { id: 'a', side: 'left', offset: 0.5 },
      { id: 'b', side: 'right', offset: 0.5 },
      { id: 'c', side: 'top', offset: 0.5 },
      { id: 'd', side: 'bottom', offset: 0.5 },
    ],
    params: [],
  },
  elbow: {
    kind: 'elbow', category: 'pipes', label: 'Elbow', role: 'passive',
    size: { w: 44, h: 44 },
    ports: [
      { id: 'in', side: 'left', offset: 0.4 },
      { id: 'out', side: 'bottom', offset: 0.6 },
    ],
    params: [],
  },
  reducer: {
    kind: 'reducer', category: 'pipes', label: 'Reducer', role: 'passive',
    size: { w: 52, h: 38 }, ports: inlinePorts, params: [],
  },
}

export interface CategoryDef {
  id: Category
  label: string
  kinds: ComponentKind[]
}

export const CATEGORIES: CategoryDef[] = [
  { id: 'pipes', label: 'Pipes & Fittings', kinds: ['tee', 'cross', 'elbow', 'reducer'] },
  {
    id: 'valves',
    label: 'Valves',
    kinds: ['mixing_valve', 'diverter_valve', 'zone_valve', 'thermostatic_valve', 'balancing_valve', 'check_valve'],
  },
  { id: 'pumps', label: 'Pumps', kinds: ['circulator', 'variable_speed_pump'] },
  {
    id: 'pump-groups',
    label: 'Pump Groups',
    kinds: ['direct_group', 'mixing_group', 'injection_group'],
  },
  { id: 'separators', label: 'Hydraulic Separators', kinds: ['hydraulic_separator', 'low_loss_header'] },
  { id: 'manifolds', label: 'Manifolds', kinds: ['manifold', 'ufh_manifold'] },
  {
    id: 'tanks',
    label: 'Tanks & Buffers',
    kinds: ['buffer_tank', 'dhw_cylinder', 'combi_cylinder', 'thermal_store'],
  },
  {
    id: 'heat-sources',
    label: 'Heat Sources',
    kinds: ['heat_pump', 'gas_boiler', 'oil_boiler', 'biomass_boiler', 'electric_boiler', 'solar_thermal', 'district_heating'],
  },
  {
    id: 'emitters',
    label: 'Heat Emitters',
    kinds: ['radiator', 'underfloor', 'fan_coil', 'towel_rail', 'air_handler'],
  },
  {
    id: 'safety',
    label: 'Safety Components',
    kinds: ['expansion_vessel', 'dirt_separator', 'air_vent', 'fill_valve', 'pressure_relief', 'strainer'],
  },
  {
    id: 'sensors',
    label: 'Sensors & Meters',
    kinds: ['sensor', 'flow_meter', 'heat_meter', 'pressure_gauge'],
  },
  { id: 'controllers', label: 'Controllers', kinds: ['weather_compensator', 'zone_controller'] },
]

// Powered devices the user can switch on/off: heat sources, pumps, pump groups,
// and zone valves (an on/off shutoff). Modulating 3-way valves are excluded —
// they control by target temp, not a power switch.
export function isToggleable(kind: ComponentKind): boolean {
  const role = CATALOG[kind].role
  return role === 'source' || role === 'pump' || role === 'group' || kind === 'zone_valve'
}

export function defaultParams(kind: ComponentKind): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of CATALOG[kind].params) out[spec.key] = spec.default
  return out
}

export function portById(kind: ComponentKind, id: string): Port | undefined {
  return CATALOG[kind].ports.find((pt) => pt.id === id)
}

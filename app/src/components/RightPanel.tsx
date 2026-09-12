import { useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { updateParam, renameNode, updateEdgeParam, setNodeEnabled } from '../store/graphSlice'
import { removeSelected } from '../store/actions'
import { CATALOG, isToggleable } from '../model/catalog'
import { tempGradient, tempColor, LINE_COLORS } from '../model/colors'
import { TEMP_MIN, TEMP_MAX } from '../model/colors'
import { formatTemp, type TempUnit } from '../store/uiSlice'
import { useT } from '../i18n/useT'

export default function RightPanel() {
  return (
    <div className="col panel panel-r">
      <Results />
      <Legend />
      <ComponentInfo />
    </div>
  )
}

function Results() {
  const { t } = useT()
  const g = useAppSelector((s) => s.sim.result.global)
  const status = useAppSelector((s) => s.sim.result.status)
  const unit = useAppSelector((s) => s.ui.tempUnit)
  const stats: [string, string, string, string][] = [
    [t('results.totalFlow'), fmt(g.flowM3h, 2), 'm³/h', '◔'],
    [t('results.systemPressure'), fmt(g.pressureKpa / 100, 2), 'bar', '◷'],
    [t('results.pumpHead'), fmt(g.headKpa, 1), 'kPa', '⇡'],
    [t('results.avgSupply'), tempVal(g.supplyC, unit), `°${unit}`, '▲'],
    [t('results.avgReturn'), tempVal(g.returnC, unit), `°${unit}`, '▼'],
    [t('results.totalHeat'), fmt(g.heatKw, 1), 'kW', '✦'],
    [t('results.systemCop'), g.cop != null ? fmt(g.cop, 2) : '—', '', '⚡'],
  ]
  return (
    <>
      <div className="phead">
        {t('results.title')}
        <span style={{ color: status === 'converged' ? 'var(--ok)' : 'var(--text-faint)' }}>
          {status === 'converged' ? `● ${t('results.live')}` : status}
        </span>
      </div>
      <div className="stat-grid">
        {stats.map(([k, v, u, icon]) => (
          <div className="stat" key={k}>
            <div className="k">
              <span style={{ color: 'var(--accent-hi)' }}>{icon}</span> {k}
            </div>
            <div className="v">
              {v}
              {u && <small>{u}</small>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function Legend() {
  const { t } = useT()
  return (
    <>
      <div className="phead">{t('legend.title')}</div>
      <div className="legend">
        <div className="row">
          <span>{t('legend.temperature')}</span>
          <div className="bar" style={{ background: tempGradient(7) }} />
        </div>
        <div className="ticks">
          <span>{TEMP_MIN}</span>
          <span>{Math.round((TEMP_MIN + TEMP_MAX) / 2)}</span>
          <span>{TEMP_MAX} °C</span>
        </div>
        <div className="row">
          <span className="sw" style={{ background: LINE_COLORS.hot }} /> {t('legend.supplyHot')}
        </div>
        <div className="row">
          <span className="sw" style={{ background: LINE_COLORS.cold }} /> {t('legend.returnCold')}
        </div>
        <div className="row">
          <span style={{ fontFamily: 'var(--font-mono)' }}>→</span> {t('legend.flowDir')}
        </div>
      </div>
    </>
  )
}

function ComponentInfo() {
  const dispatch = useAppDispatch()
  const { t, comp, param } = useT()
  const sel = useAppSelector((s) => s.selection)
  const unit = useAppSelector((s) => s.ui.tempUnit)
  const node = useAppSelector((s) => s.graph.nodes.find((n) => n.id === s.selection.nodeId))
  const edge = useAppSelector((s) => s.graph.edges.find((e) => e.id === s.selection.edgeId))

  if (node) {
    const def = CATALOG[node.data.kind]
    const r = node.data.result
    // A DHW cylinder stores domestic hot water at a setpoint while a boiler-side
    // coil charges it. The solver reports the coil loop in supplyC/returnC, where
    // the return (coil inlet, hot from the boiler) is HOTTER than the supply (coil
    // outlet) — confusing under generic "Supply / Return" labels. Relabel so it
    // reads as a store: Stored = setpoint, Coil in/out = the boiler-side temps.
    const isDhw =
      node.data.kind === 'dhw_cylinder' ||
      (def.role === 'tank' && node.data.params.setpointC !== undefined)
    return (
      <>
        <div className="phead">{t('info.title')}</div>
        <div style={{ padding: '2px 12px 8px' }}>
          <input
            className="search"
            style={{ margin: '0 0 6px', width: '100%' }}
            aria-label={t('info.title')}
            value={node.data.label === def.label ? comp(node.data.kind) : node.data.label}
            onChange={(e) => dispatch(renameNode({ nodeId: node.id, label: e.target.value }))}
          />
          <div className="info-row" style={{ padding: '2px 0' }}>
            <span className="lab">{t('info.type')}</span>
            <span className="val">{comp(node.data.kind)}</span>
          </div>
          {isToggleable(node.data.kind) && (
            <div className="info-row" style={{ padding: '6px 0 2px' }}>
              <span className="lab">{t('power.label')}</span>
              <button
                className={`power-toggle${node.data.enabled === false ? ' off' : ' on'}`}
                title={t('power.hint')}
                aria-pressed={node.data.enabled !== false}
                onClick={() =>
                  dispatch(setNodeEnabled({ nodeId: node.id, enabled: node.data.enabled === false }))
                }
              >
                <span className="dot" />
                {node.data.enabled === false ? t('power.off') : t('power.on')}
              </button>
            </div>
          )}
        </div>
        {r && (
          <div style={{ padding: '0 0 6px' }}>
            {isDhw ? (
              <>
                {node.data.params.setpointC !== undefined && (
                  <Readout
                    label={t('info.stored')}
                    value={formatTemp(node.data.params.setpointC, unit)}
                    color={tempColor(node.data.params.setpointC)}
                    hint={t('info.storedHint')}
                  />
                )}
                {r.returnC !== undefined && (
                  <Readout
                    label={t('info.coilIn')}
                    value={formatTemp(r.returnC, unit)}
                    color={tempColor(r.returnC)}
                    hint={t('info.coilInHint')}
                  />
                )}
                {r.supplyC !== undefined && (
                  <Readout
                    label={t('info.coilOut')}
                    value={formatTemp(r.supplyC, unit)}
                    color={tempColor(r.supplyC)}
                    hint={t('info.coilOutHint')}
                  />
                )}
              </>
            ) : (
              <>
                {r.supplyC !== undefined && <Readout label={t('info.supply')} value={formatTemp(r.supplyC, unit)} color={tempColor(r.supplyC)} />}
                {r.returnC !== undefined && <Readout label={t('info.return')} value={formatTemp(r.returnC, unit)} color={tempColor(r.returnC)} />}
              </>
            )}
            {r.heatKw !== undefined && <Readout label={t('info.power')} value={`${r.heatKw.toFixed(2)} kW`} />}
            {r.cop !== undefined && <Readout label={t('info.cop')} value={r.cop.toFixed(2)} />}
            {r.valvePct !== undefined && <Readout label={t('info.valvePos')} value={`${r.valvePct} %`} />}
          </div>
        )}
        <div className="phead">{t('info.parameters')}</div>
        {def.params.map((spec) => (
          <div className="param-row" key={spec.key}>
            <label htmlFor={`param-${node.id}-${spec.key}`}>
              {param(spec.label)} {spec.unit && <span className="unit">{spec.unit}</span>}
            </label>
            <NumInput
              key={`${node.id}-${spec.key}`}
              id={`param-${node.id}-${spec.key}`}
              value={node.data.params[spec.key] ?? spec.default}
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 1}
              onCommit={(value) => dispatch(updateParam({ nodeId: node.id, key: spec.key, value }))}
            />
          </div>
        ))}
        <div style={{ padding: '14px 12px' }}>
          <button className="danger-btn" onClick={() => dispatch(removeSelected())}>
            {t('info.removeComponent')}
          </button>
        </div>
      </>
    )
  }

  if (edge) {
    const r = edge.data?.result
    return (
      <>
        <div className="phead">{t('pipe.title')}</div>
        {r && (
          <div style={{ padding: '0 0 6px' }}>
            <Readout label={t('pipe.temperature')} value={formatTemp(r.tempC, unit)} color={tempColor(r.tempC)} />
            <Readout label={t('pipe.flowLpm')} value={`${(r.flowM3h * 1000 / 60).toFixed(1)} L/min`} />
            <Readout label={t('pipe.flowRate')} value={`${r.flowM3h.toFixed(2)} m³/h`} />
            <Readout label={t('pipe.line')} value={t('line.' + r.line)} />
          </div>
        )}
        <div className="phead">{t('info.parameters')}</div>
        <div className="param-row">
          <label htmlFor={`pipe-${edge.id}-length`}>{t('pipe.length')} <span className="unit">m</span></label>
          <NumInput
            key={`${edge.id}-length`}
            id={`pipe-${edge.id}-length`}
            value={edge.data?.lengthM ?? 4}
            min={0.1}
            max={200}
            step={0.5}
            onCommit={(value) => dispatch(updateEdgeParam({ edgeId: edge.id, key: 'lengthM', value }))}
          />
        </div>
        <div className="param-row">
          <label htmlFor={`pipe-${edge.id}-diameter`}>{t('pipe.diameter')} <span className="unit">mm</span></label>
          <NumInput
            key={`${edge.id}-diameter`}
            id={`pipe-${edge.id}-diameter`}
            value={edge.data?.diameterMm ?? 22}
            min={5}
            max={200}
            step={1}
            onCommit={(value) => dispatch(updateEdgeParam({ edgeId: edge.id, key: 'diameterMm', value }))}
          />
        </div>
        <div style={{ padding: '14px 12px' }}>
          <button className="danger-btn" onClick={() => dispatch(removeSelected())}>
            {t('pipe.removePipe')}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="phead">{t('info.title')}</div>
      <div className="empty-hint">
        {t('info.emptyHint')}
        <br />
        <br />
        {t('info.emptyHint2')} {sel.nodeId ? '' : t('info.emptyAuto')}
      </div>
    </>
  )
}

// Numeric input that only commits finite, in-range values. Typing keeps a local
// draft (so the field can be cleared mid-edit without dispatching 0 into the
// solver — Number('') === 0); out-of-range values clamp and commit on blur.
function NumInput({
  id,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  id?: string
  value: number
  min?: number
  max?: number
  step?: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clampVal = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const parse = (s: string): number | null => {
    if (s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }
  return (
    <input
      id={id}
      className="num"
      type="number"
      value={draft ?? String(value)}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setDraft(e.target.value)
        const v = parse(e.target.value)
        if (v !== null && v === clampVal(v)) onCommit(v)
      }}
      onBlur={() => {
        const v = parse(draft ?? '')
        if (v !== null) onCommit(clampVal(v))
        setDraft(null)
      }}
    />
  )
}

function Readout({
  label,
  value,
  color,
  hint,
}: {
  label: string
  value: string
  color?: string
  hint?: string
}) {
  return (
    <div className="info-row" title={hint}>
      <span className="lab">{label}</span>
      <span className="val" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  )
}

function fmt(n: number, dp: number): string {
  if (!isFinite(n)) return '—'
  return n.toFixed(dp)
}

// Numeric-only temperature (no unit suffix) for the stat grid, which renders the
// unit separately in <small>.
function tempVal(celsius: number, unit: TempUnit): string {
  if (!isFinite(celsius)) return '—'
  return formatTemp(celsius, unit).replace(/ °[CF]$/, '')
}

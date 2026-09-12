import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from 'recharts'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { setBottomTab } from '../store/uiSlice'
import { tempColor, LINE_COLORS } from '../model/colors'
import { CATALOG } from '../model/catalog'
import { useT } from '../i18n/useT'

const TAB_IDS: ('overview' | 'charts' | 'table' | 'energy' | 'pumps')[] = [
  'overview',
  'charts',
  'table',
  'energy',
  'pumps',
]

const axis = { stroke: '#3a4658', fontSize: 9, tickLine: false }
const grid = { stroke: '#16202d' }

export default function ChartsPanel() {
  const dispatch = useAppDispatch()
  const { t } = useT()
  const tab = useAppSelector((s) => s.ui.bottomTab)
  return (
    <div className="charts-panel">
      <div className="tabs">
        {TAB_IDS.map((id) => (
          <button
            key={id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => dispatch(setBottomTab(id))}
          >
            {t('charts.tab.' + id)}
          </button>
        ))}
      </div>
      <div className="charts-body" style={tab === 'table' || tab === 'energy' ? { gridTemplateColumns: '1fr' } : undefined}>
        {(tab === 'charts' || tab === 'overview') && <ChartsView />}
        {tab === 'table' && <TableView />}
        {tab === 'energy' && <EnergyView />}
        {tab === 'pumps' && <PumpView />}
      </div>
    </div>
  )
}

function ChartsView() {
  const { t } = useT()
  const result = useAppSelector((s) => s.sim.result)
  const nodes = useAppSelector((s) => s.graph.nodes)
  const edges = useAppSelector((s) => s.graph.edges)
  const frames = useAppSelector((s) => s.playback.frames)
  const idx = useAppSelector((s) => s.playback.idx)
  const history = result.history

  const flowData = edges
    .map((e) => ({ name: e.id, flow: e.data?.result?.flowM3h ?? 0 }))
    .filter((d) => d.flow > 0.03)
    .sort((a, b) => b.flow - a.flow)
    .slice(0, 7)

  const tank = nodes.find((n) => n.data.kind === 'buffer_tank' && n.data.result?.strat)
  const strat = tank?.data.result?.strat

  // transient: temperature & heat over real (simulated) time; else convergence
  const transient = frames.length > 1
  const bufId = nodes.find((n) => n.data.kind === 'buffer_tank')?.id
  const tempSeries = transient
    ? frames.map((f) => {
        const st = bufId ? f.nodes[bufId]?.strat : undefined
        return {
          x: Number((f.t / 60).toFixed(1)),
          supplyC: f.global.supplyC,
          returnC: f.global.returnC,
          bufTop: st ? st[0] : undefined,
          bufBot: st ? st[st.length - 1] : undefined,
          heatKw: f.global.heatKw,
        }
      })
    : history.map((h) => ({ x: h.iter, supplyC: h.supplyC, returnC: h.returnC, heatKw: h.heatKw }))
  const playheadX = transient && frames[idx] ? Number((frames[idx].t / 60).toFixed(1)) : undefined
  const xLabel = transient ? t('charts.min') : t('charts.iter')

  return (
    <>
      <div className="chart">
        <h4>{t('charts.supplyReturn')}{transient ? ` ${t('charts.overTime')}` : ''}</h4>
        <div className="wrap">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={tempSeries} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="x" {...axis} unit={transient ? 'm' : ''} />
              <YAxis {...axis} width={28} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `${v} ${xLabel}`} />
              {transient && <Line type="monotone" dataKey="bufTop" stroke="#f0a020" dot={false} strokeWidth={1.5} strokeDasharray="4 3" isAnimationActive={false} name={t('charts.bufferTop')} />}
              {transient && <Line type="monotone" dataKey="bufBot" stroke="#2dd4bf" dot={false} strokeWidth={1.5} strokeDasharray="4 3" isAnimationActive={false} name={t('charts.bufferBottom')} />}
              <Line type="monotone" dataKey="supplyC" stroke={LINE_COLORS.hot} dot={false} strokeWidth={2} isAnimationActive={false} name={t('charts.supply')} />
              <Line type="monotone" dataKey="returnC" stroke={LINE_COLORS.cold} dot={false} strokeWidth={2} isAnimationActive={false} name={t('charts.return')} />
              {playheadX !== undefined && <ReferenceLine x={playheadX} stroke="#cdd7e6" strokeOpacity={0.5} strokeWidth={1} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="clegend">
          <span><span className="dot" style={{ background: LINE_COLORS.hot }} />{t('charts.supply')} {result.global.supplyC.toFixed(1)}°C</span>
          <span><span className="dot" style={{ background: LINE_COLORS.cold }} />{t('charts.return')} {result.global.returnC.toFixed(1)}°C</span>
          {transient && <span><span className="dot" style={{ background: '#f0a020' }} />{t('charts.bufTop')}</span>}
          {transient && <span><span className="dot" style={{ background: '#2dd4bf' }} />{t('charts.bufBot')}</span>}
        </div>
      </div>

      <div className="chart">
        <h4>{t('charts.flowByPipe')}</h4>
        <div className="wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={flowData} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="name" {...axis} hide />
              <YAxis {...axis} width={28} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="flow" radius={[3, 3, 0, 0]}>
                {flowData.map((_, i) => (
                  <Cell key={i} fill={LINE_COLORS.cold} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="clegend">
          <span>{t('charts.flowTotal', { flow: result.global.flowM3h.toFixed(2), n: flowData.length })}</span>
        </div>
      </div>

      <div className="chart">
        <h4>{t('charts.heatOutput')}{transient ? ` ${t('charts.overTime')}` : ''}</h4>
        <div className="wrap">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={tempSeries} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
              <defs>
                <linearGradient id="heatFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a855f7" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="x" {...axis} unit={transient ? 'm' : ''} />
              <YAxis {...axis} width={28} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `${v} ${xLabel}`} />
              <Area type="monotone" dataKey="heatKw" stroke="#b675f4" fill="url(#heatFill)" strokeWidth={2} isAnimationActive={false} />
              {playheadX !== undefined && <ReferenceLine x={playheadX} stroke="#cdd7e6" strokeOpacity={0.5} strokeWidth={1} />}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="clegend">
          <span><span className="dot" style={{ background: '#b675f4' }} />{t('charts.heatTotal', { heat: result.global.heatKw.toFixed(1) })}</span>
        </div>
      </div>

      <div className="chart">
        <h4>{t('charts.stratification')}</h4>
        <div className="wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          {strat ? <Stratification strat={strat} /> : <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('charts.noBufferTank')}</span>}
        </div>
      </div>
    </>
  )
}

function Stratification({ strat }: { strat: number[] }) {
  return (
    <>
      <div
        style={{
          width: 34,
          height: '88%',
          borderRadius: 10,
          border: '1px solid var(--line-2)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {strat.map((t, i) => (
          <div key={i} style={{ flex: 1, background: tempColor(t) }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '88%', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
        {strat.map((t, i) => (
          <span key={i}>{t.toFixed(0)}°</span>
        ))}
      </div>
    </>
  )
}

function TableView() {
  const { t, comp } = useT()
  const nodes = useAppSelector((s) => s.graph.nodes)
  const rows = nodes.filter((n) => n.data.result && (n.data.result.heatKw !== undefined || n.data.result.supplyC !== undefined))
  const headers = [
    t('charts.component'),
    t('info.type'),
    `${t('charts.supply')} °C`,
    `${t('charts.return')} °C`,
    `${t('charts.power')} kW`,
    t('info.cop'),
  ]
  return (
    <div style={{ overflow: 'auto', width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
            {headers.map((h) => (
              <th key={h} style={{ padding: '5px 10px', borderBottom: '1px solid var(--line)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((n) => {
            const r = n.data.result!
            return (
              <tr key={n.id} style={{ color: 'var(--text)' }}>
                <td style={cell}>{n.data.label}</td>
                <td style={{ ...cell, color: 'var(--text-dim)' }}>{comp(n.data.kind)}</td>
                <td style={cell}>{r.supplyC?.toFixed(1) ?? '—'}</td>
                <td style={cell}>{r.returnC?.toFixed(1) ?? '—'}</td>
                <td style={cell}>{r.heatKw?.toFixed(2) ?? '—'}</td>
                <td style={cell}>{r.cop?.toFixed(2) ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function EnergyView() {
  const nodes = useAppSelector((s) => s.graph.nodes)
  const data = nodes
    .filter((n) => n.data.result?.heatKw)
    .map((n) => ({ name: n.data.label, kw: Math.abs(n.data.result!.heatKw!), source: CATALOG[n.data.kind].role === 'source' }))
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 40 }}>
          <CartesianGrid {...grid} horizontal={false} />
          <XAxis type="number" {...axis} />
          <YAxis type="category" dataKey="name" {...axis} width={90} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="kw" radius={[0, 3, 3, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.source ? LINE_COLORS.hot : LINE_COLORS.cold} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function PumpView() {
  // Pump curve H(Q) = h0 (1 - (Q/qmax)^2) for each pump / pump group in the system.
  const { t } = useT()
  const nodes = useAppSelector((s) => s.graph.nodes)
  // catalog-role match so every pump kind is included (variable-speed pumps,
  // injection groups, …), not just a hard-coded subset
  const pumps = nodes.filter((n) => {
    const role = CATALOG[n.data.kind]?.role
    return role === 'pump' || role === 'group'
  })
  // one series per pump spanning ITS OWN qMax, plotted on a shared numeric X
  // axis — a single shared row set would stretch every curve to pump 0's range
  const series = pumps.map((p) => {
    const qmax = p.data.params.qMaxM3h ?? 3
    const h0 = p.data.params.h0Kpa ?? 45
    return Array.from({ length: 21 }, (_, i) => ({
      q: Number(((i / 20) * qmax).toFixed(2)),
      h: Math.max(0, h0 * (1 - (i / 20) ** 2)),
    }))
  })
  return (
    <div className="chart" style={{ gridColumn: '1 / -1' }}>
      <h4>{t('charts.pumpCurves')}</h4>
      <div className="wrap">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="q" type="number" domain={[0, 'dataMax']} {...axis} />
            <YAxis {...axis} width={30} />
            <Tooltip contentStyle={tooltipStyle} />
            {pumps.map((p, idx) => (
              <Line key={p.id} data={series[idx]} type="monotone" dataKey="h" stroke={['#3b82f6', '#e5484d', '#a855f7', '#2dd4bf'][idx % 4]} dot={false} strokeWidth={2} isAnimationActive={false} name={p.data.label} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

const cell: React.CSSProperties = { padding: '4px 10px', borderBottom: '1px solid var(--line)' }
const tooltipStyle: React.CSSProperties = {
  background: '#0c111a',
  border: '1px solid var(--line-2)',
  borderRadius: 8,
  fontSize: 11,
  color: 'var(--text)',
}

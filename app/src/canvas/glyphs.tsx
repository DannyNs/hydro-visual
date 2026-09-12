import type { ComponentKind, NodeResult } from '../model/types'
import { tempColor } from '../model/colors'

interface GlyphProps {
  kind: ComponentKind
  w: number
  h: number
  result?: NodeResult
  params: Record<string, number>
  /** unique per node instance — keeps SVG gradient ids from colliding between
   *  the palette glyph and canvas glyphs of the same kind */
  uid?: string
}

const STROKE = '#94a4b8'
const STROKE_HI = '#c4d2e3'
const FILL = '#10161f'
const FILL_HI = '#18212e'

export function Glyph({ kind, w, h, result, params, uid }: GlyphProps) {
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="glyph-svg">
      {renderGlyph(kind, w, h, result, params, uid ?? kind)}
    </svg>
  )
}

function renderGlyph(
  kind: ComponentKind,
  w: number,
  h: number,
  result: GlyphProps['result'],
  params: Record<string, number>,
  uid: string,
) {
  const s = {
    stroke: STROKE,
    fill: 'none',
    strokeWidth: 1.6,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  }
  const body = { fill: FILL, stroke: STROKE, strokeWidth: 1.4 }

  switch (kind) {
    case 'heat_pump': {
      const fx = w * 0.36
      const fy = h * 0.5
      const r = Math.min(w, h) * 0.27
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 18} rx={9} {...body} />
          <rect x={w * 0.5} y={12} width={w * 0.42} height={h - 30} rx={5} fill={FILL_HI} stroke="none" />
          {[0, 1, 2, 3, 4].map((i) => (
            <line key={i} x1={w * 0.53} y1={16 + i * ((h - 36) / 4)} x2={w * 0.88} y2={16 + i * ((h - 36) / 4)} stroke={STROKE} strokeWidth={1.2} opacity={0.7} />
          ))}
          <circle cx={fx} cy={fy} r={r} fill="#0c1119" stroke={STROKE} strokeWidth={1.4} />
          {[0, 1, 2, 3].map((i) => {
            const a = (i * Math.PI) / 2
            return (
              <path
                key={i}
                d={`M${fx},${fy} q${Math.cos(a) * r * 0.9},${Math.sin(a) * r * 0.3} ${Math.cos(a + 0.7) * r * 0.85},${Math.sin(a + 0.7) * r * 0.85}`}
                stroke={STROKE_HI}
                strokeWidth={1.3}
                fill="none"
              />
            )
          })}
          <circle cx={fx} cy={fy} r={2.2} fill={STROKE_HI} />
          <line x1={12} y1={h - 12} x2={12} y2={h - 7} {...s} />
          <line x1={w - 12} y1={h - 12} x2={w - 12} y2={h - 7} {...s} />
        </g>
      )
    }
    case 'gas_boiler': {
      const supC = result?.supplyC
      return (
        <g>
          <rect x={5} y={5} width={w - 10} height={h - 22} rx={8} {...body} />
          <rect x={11} y={11} width={w - 22} height={h * 0.42} rx={4} fill={FILL_HI} stroke="none" />
          <circle cx={w * 0.32} cy={11 + h * 0.21} r={4} fill="none" stroke={STROKE} strokeWidth={1.2} />
          <rect x={w * 0.5} y={11 + h * 0.12} width={w * 0.3} height={h * 0.16} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          {/* burner flame */}
          <path
            d={`M${w / 2},${h - 14} q-7,-9 0,-18 q7,9 0,18`}
            fill={supC && supC > 30 ? '#e8633a' : '#33414f'}
            opacity={0.9}
          />
          <path d={`M${w / 2},${h - 16} q-3,-5 0,-10 q3,5 0,10`} fill={supC && supC > 30 ? '#ffd27a' : '#475569'} />
          <line x1={14} y1={h - 12} x2={14} y2={h - 6} {...s} />
          <line x1={w - 14} y1={h - 12} x2={w - 14} y2={h - 6} {...s} />
        </g>
      )
    }
    case 'circulator': {
      const r = Math.min(w, h) * 0.4
      return (
        <g>
          <line x1={2} y1={h / 2} x2={w - 2} y2={h / 2} stroke={STROKE} strokeWidth={3} />
          <circle cx={w / 2} cy={h / 2} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.6} />
          <circle cx={w / 2} cy={h / 2} r={r * 0.4} fill="none" stroke={STROKE_HI} strokeWidth={1.4} />
          <path d={`M${w / 2},${h / 2} L${w / 2 + r * 0.55},${h / 2 - r * 0.35}`} stroke={STROKE_HI} strokeWidth={1.6} />
        </g>
      )
    }
    case 'direct_group':
    case 'mixing_group':
    case 'injection_group': {
      const mixing = kind !== 'direct_group'
      const yHot = h * 0.28
      const yCold = h * 0.74
      const pr = Math.min(w, h) * 0.16
      return (
        <g>
          <rect x={6} y={8} width={w - 12} height={h - 22} rx={9} {...body} />
          {/* hot supply path (top) with the circulator pump */}
          <line x1={6} y1={yHot} x2={w - 6} y2={yHot} stroke="#b85563" strokeWidth={3} opacity={0.85} />
          <circle cx={w * 0.6} cy={yHot} r={pr} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <path d={`M${w * 0.6},${yHot} l${pr * 0.55},${-pr * 0.3}`} stroke={STROKE_HI} strokeWidth={1.3} />
          {/* cool return path (bottom) */}
          <line x1={6} y1={yCold} x2={w - 6} y2={yCold} stroke="#4671c4" strokeWidth={3} opacity={0.85} />
          {/* mixing valve linking supply<->return (3-way) for the mixing types */}
          {mixing ? (
            <g>
              <line x1={w * 0.36} y1={yCold} x2={w * 0.36} y2={yHot} stroke={STROKE} strokeWidth={1.4} opacity={0.7} />
              <path
                d={`M${w * 0.31},${h * 0.5} L${w * 0.41},${h * 0.45} L${w * 0.41},${h * 0.55} Z`}
                fill="none"
                stroke={STROKE}
                strokeWidth={1.3}
              />
              <circle cx={w * 0.36} cy={h * 0.4} r={2} fill={STROKE_HI} />
            </g>
          ) : (
            <line x1={w * 0.34} y1={yHot} x2={w * 0.34} y2={yCold} stroke={STROKE} strokeWidth={1.3} opacity={0.6} />
          )}
          {/* four port stubs: left = primary, right = secondary; red hot, blue cool */}
          <line x1={2} y1={yHot} x2={6} y2={yHot} stroke="#e5777c" strokeWidth={2.6} />
          <line x1={2} y1={yCold} x2={6} y2={yCold} stroke="#6f9bdd" strokeWidth={2.6} />
          <line x1={w - 6} y1={yHot} x2={w - 2} y2={yHot} stroke="#e5777c" strokeWidth={2.6} />
          <line x1={w - 6} y1={yCold} x2={w - 2} y2={yCold} stroke="#6f9bdd" strokeWidth={2.6} />
        </g>
      )
    }
    case 'radiator': {
      const n = 7
      const mean = result ? ((result.supplyC ?? 40) + (result.returnC ?? 30)) / 2 : undefined
      return (
        <g>
          <rect x={5} y={8} width={w - 10} height={h - 16} rx={4} fill={mean ? tempColor(mean) : FILL} opacity={mean ? 0.16 : 1} stroke="none" />
          <rect x={5} y={8} width={w - 10} height={h - 16} rx={4} fill="none" stroke={STROKE} strokeWidth={1.4} />
          {Array.from({ length: n }).map((_, i) => {
            const x = 5 + ((w - 10) / n) * (i + 0.5)
            return <line key={i} x1={x} y1={12} x2={x} y2={h - 12} stroke={STROKE} strokeWidth={1.3} opacity={0.8} />
          })}
          <line x1={5} y1={13} x2={w - 5} y2={13} stroke={STROKE} strokeWidth={1.3} />
          <line x1={5} y1={h - 13} x2={w - 5} y2={h - 13} stroke={STROKE} strokeWidth={1.3} />
        </g>
      )
    }
    case 'underfloor': {
      const rows = 3
      const pts: string[] = []
      const x0 = 9
      const x1 = w - 9
      for (let i = 0; i < rows; i++) {
        const y = 16 + (i * (h - 30)) / (rows - 1)
        pts.push(`${i % 2 === 0 ? x0 : x1},${y} ${i % 2 === 0 ? x1 : x0},${y}`)
      }
      return (
        <g>
          <rect x={4} y={6} width={w - 8} height={h - 12} rx={5} {...body} />
          <polyline points={pts.join(' ')} fill="none" stroke="#b85563" strokeWidth={2} opacity={0.85} strokeLinejoin="round" />
        </g>
      )
    }
    case 'buffer_tank':
    case 'dhw_cylinder': {
      const strat = result?.strat
      const topR = w * 0.42
      return (
        <g>
          <defs>
            <linearGradient id={`tank-${uid}`} x1="0" y1="0" x2="0" y2="1">
              {strat
                ? strat.map((t, i) => (
                    <stop key={i} offset={`${(i / (strat.length - 1)) * 100}%`} stopColor={tempColor(t)} />
                  ))
                : [
                    <stop key="a" offset="0%" stopColor="#9aa6b6" />,
                    <stop key="b" offset="100%" stopColor="#6b7686" />,
                  ]}
            </linearGradient>
          </defs>
          <rect x={w / 2 - topR} y={8} width={topR * 2} height={h - 16} rx={topR * 0.55} fill={`url(#tank-${uid})`} stroke={STROKE} strokeWidth={1.5} opacity={strat ? 0.92 : 0.5} />
          <ellipse cx={w / 2} cy={12} rx={topR} ry={5} fill="#0e141e" stroke={STROKE} strokeWidth={1.2} />
          {kind === 'dhw_cylinder' && (
            <path d={`M${w / 2 - 6},${20} q12,${(h - 40) / 3} 0,${(h - 40) / 1.5} q-12,${(h - 40) / 3} 0,${(h - 40) / 1.5}`} fill="none" stroke="#0c1119" strokeWidth={2.2} opacity={0.55} />
          )}
          {/* port stubs */}
          <line x1={w / 2 - topR} y1={h * 0.28} x2={w / 2 - topR - 5} y2={h * 0.28} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + topR} y1={h * 0.28} x2={w / 2 + topR + 5} y2={h * 0.28} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'hydraulic_separator': {
      return (
        <g>
          <rect x={w / 2 - 14} y={6} width={28} height={h - 12} rx={13} {...body} />
          {[0.28, 0.5, 0.72].map((p, i) => (
            <circle key={i} cx={w / 2} cy={6 + (h - 12) * p} r={2} fill={STROKE} opacity={0.6} />
          ))}
          <line x1={w / 2 - 14} y1={h * 0.26} x2={4} y2={h * 0.26} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 - 14} y1={h * 0.74} x2={4} y2={h * 0.74} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + 14} y1={h * 0.26} x2={w - 4} y2={h * 0.26} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + 14} y1={h * 0.74} x2={w - 4} y2={h * 0.74} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'manifold': {
      const drops = 2
      return (
        <g>
          <rect x={4} y={h * 0.22} width={w - 8} height={6} rx={3} fill="#b85563" opacity={0.8} stroke="none" />
          <rect x={4} y={h * 0.55} width={w - 8} height={6} rx={3} fill="#4671c4" opacity={0.8} stroke="none" />
          {Array.from({ length: drops }).map((_, i) => {
            const x = w * 0.45 + i * (w * 0.3)
            return (
              <g key={i}>
                <line x1={x} y1={h * 0.25} x2={x} y2={h - 6} stroke={STROKE} strokeWidth={1.6} />
                <line x1={x + 8} y1={h * 0.58} x2={x + 8} y2={h - 6} stroke={STROKE} strokeWidth={1.6} />
              </g>
            )
          })}
        </g>
      )
    }
    case 'mixing_valve': {
      const r = Math.min(w, h) * 0.36
      return (
        <g>
          <circle cx={w / 2} cy={h / 2} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.6} />
          <path d={`M${w / 2},${h / 2} L${w / 2 - r},${h / 2} M${w / 2},${h / 2} L${w / 2 + r * 0.7},${h / 2 - r * 0.7} M${w / 2},${h / 2} L${w / 2},${h / 2 + r}`} stroke={STROKE_HI} strokeWidth={1.8} />
          <circle cx={w / 2} cy={h / 2} r={2.4} fill={STROKE_HI} />
        </g>
      )
    }
    case 'expansion_vessel': {
      return (
        <g>
          <rect x={w / 2 - 12} y={6} width={24} height={h - 22} rx={11} fill="#b03b44" opacity={0.85} stroke={STROKE} strokeWidth={1.3} />
          <line x1={w / 2 - 12} y1={h * 0.5} x2={w / 2 + 12} y2={h * 0.5} stroke="#0e141e" strokeWidth={1.4} />
          <line x1={w / 2} y1={h - 16} x2={w / 2} y2={h - 6} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 - 7} y1={h - 6} x2={w / 2 + 7} y2={h - 6} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'dirt_separator': {
      return (
        <g>
          <line x1={2} y1={h * 0.42} x2={w - 2} y2={h * 0.42} stroke={STROKE} strokeWidth={3} />
          <rect x={w / 2 - 9} y={h * 0.34} width={18} height={16} rx={4} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <path d={`M${w / 2 - 6},${h * 0.55} L${w / 2 + 6},${h * 0.55} L${w / 2 + 3},${h - 8} L${w / 2 - 3},${h - 8} Z`} fill="#0c1119" stroke={STROKE} strokeWidth={1.2} />
        </g>
      )
    }
    case 'air_vent': {
      return (
        <g>
          <line x1={w / 2} y1={h - 4} x2={w / 2} y2={h * 0.5} stroke={STROKE} strokeWidth={2} />
          <circle cx={w / 2} cy={h * 0.36} r={Math.min(w, h) * 0.22} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <rect x={w / 2 - 3} y={5} width={6} height={7} rx={2} fill={STROKE} opacity={0.8} />
        </g>
      )
    }
    case 'fill_valve': {
      const cy = h * 0.55
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          <path d={`M${w / 2 - 9},${cy - 8} L${w / 2 + 9},${cy + 8} M${w / 2 - 9},${cy + 8} L${w / 2 + 9},${cy - 8}`} stroke={STROKE} strokeWidth={1.5} />
          <line x1={w / 2} y1={cy - 6} x2={w / 2} y2={6} stroke={STROKE} strokeWidth={1.5} />
          <circle cx={w / 2} cy={6} r={3} fill={STROKE} opacity={0.8} />
        </g>
      )
    }
    case 'sensor': {
      return (
        <g>
          <circle cx={w / 2} cy={h / 2} r={Math.min(w, h) * 0.42} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize={13} fill={STROKE_HI} fontFamily="monospace">T</text>
        </g>
      )
    }
    case 'oil_boiler': {
      const supC = result?.supplyC
      const dx = w * 0.34
      const dy = 11 + h * 0.2
      return (
        <g>
          <rect x={5} y={5} width={w - 10} height={h - 22} rx={8} {...body} />
          <rect x={11} y={11} width={w - 22} height={h * 0.42} rx={4} fill={FILL_HI} stroke="none" />
          {/* oil drop */}
          <path d={`M${dx},${dy - 8} q6,7 0,12 q-6,-5 0,-12`} fill={supC && supC > 30 ? '#e8a23a' : '#33414f'} stroke={STROKE} strokeWidth={1.1} />
          <rect x={w * 0.56} y={11 + h * 0.12} width={w * 0.26} height={h * 0.16} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          <path d={`M${w / 2},${h - 14} q-6,-8 0,-15 q6,7 0,15`} fill={supC && supC > 30 ? '#e8633a' : '#33414f'} opacity={0.9} />
          <line x1={14} y1={h - 12} x2={14} y2={h - 6} {...s} />
          <line x1={w - 14} y1={h - 12} x2={w - 14} y2={h - 6} {...s} />
        </g>
      )
    }
    case 'biomass_boiler': {
      const supC = result?.supplyC
      const lx = w * 0.34
      const ly = 11 + h * 0.2
      return (
        <g>
          <rect x={5} y={5} width={w - 10} height={h - 22} rx={8} {...body} />
          <rect x={11} y={11} width={w - 22} height={h * 0.42} rx={4} fill={FILL_HI} stroke="none" />
          {/* pellet / leaf */}
          <path d={`M${lx - 6},${ly + 5} q6,-14 12,0 q-6,4 -12,0`} fill={supC && supC > 30 ? '#5bbf6a' : '#33414f'} stroke={STROKE} strokeWidth={1.1} />
          <path d={`M${lx - 5},${ly + 4} L${lx + 5},${ly - 4}`} stroke={STROKE} strokeWidth={1} opacity={0.7} />
          <rect x={w * 0.56} y={11 + h * 0.12} width={w * 0.26} height={h * 0.16} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          <path d={`M${w / 2},${h - 14} q-6,-8 0,-15 q6,7 0,15`} fill={supC && supC > 30 ? '#e8633a' : '#33414f'} opacity={0.9} />
          <line x1={14} y1={h - 12} x2={14} y2={h - 6} {...s} />
          <line x1={w - 14} y1={h - 12} x2={w - 14} y2={h - 6} {...s} />
        </g>
      )
    }
    case 'electric_boiler': {
      const supC = result?.supplyC
      const bx = w * 0.36
      const by = 11 + h * 0.06
      const bh = h * 0.32
      const hot = supC && supC > 30
      return (
        <g>
          <rect x={5} y={5} width={w - 10} height={h - 22} rx={8} {...body} />
          <rect x={11} y={11} width={w - 22} height={h * 0.42} rx={4} fill={FILL_HI} stroke="none" />
          {/* lightning bolt */}
          <path
            d={`M${bx + 4},${by} L${bx - 4},${by + bh * 0.55} L${bx + 1},${by + bh * 0.55} L${bx - 3},${by + bh} L${bx + 7},${by + bh * 0.4} L${bx + 2},${by + bh * 0.4} Z`}
            fill={hot ? '#ffd27a' : '#475569'}
            stroke={STROKE}
            strokeWidth={1}
          />
          <rect x={w * 0.56} y={11 + h * 0.12} width={w * 0.26} height={h * 0.16} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          <line x1={14} y1={h - 12} x2={14} y2={h - 6} {...s} />
          <line x1={w - 14} y1={h - 12} x2={w - 14} y2={h - 6} {...s} />
        </g>
      )
    }
    case 'solar_thermal': {
      const x0 = 6
      const y0 = h * 0.28
      const pw = w - 12
      const ph = h - y0 - 8
      return (
        <g>
          {/* small sun */}
          <circle cx={w * 0.8} cy={h * 0.16} r={Math.min(w, h) * 0.1} fill="none" stroke="#e8a23a" strokeWidth={1.4} />
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const a = (i * Math.PI) / 3
            const r0 = Math.min(w, h) * 0.13
            const r1 = Math.min(w, h) * 0.19
            return (
              <line
                key={i}
                x1={w * 0.8 + Math.cos(a) * r0}
                y1={h * 0.16 + Math.sin(a) * r0}
                x2={w * 0.8 + Math.cos(a) * r1}
                y2={h * 0.16 + Math.sin(a) * r1}
                stroke="#e8a23a"
                strokeWidth={1.2}
              />
            )
          })}
          {/* flat panel */}
          <rect x={x0} y={y0} width={pw} height={ph} rx={3} fill={FILL_HI} stroke={STROKE} strokeWidth={1.5} />
          {[0.25, 0.5, 0.75].map((p, i) => (
            <line key={i} x1={x0 + 4} y1={y0 + ph - 4} x2={x0 + pw * p} y2={y0 + 4} stroke={STROKE_HI} strokeWidth={1.2} opacity={0.8} />
          ))}
        </g>
      )
    }
    case 'district_heating': {
      const cy = h / 2
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 12} rx={8} {...body} />
          {/* heat-exchanger: two interleaved counter-arrows */}
          <path d={`M${w * 0.28},${cy - 7} L${w * 0.72},${cy - 7}`} stroke={STROKE_HI} strokeWidth={1.6} />
          <path d={`M${w * 0.72},${cy - 7} l-6,-4 m6,4 l-6,4`} stroke={STROKE_HI} strokeWidth={1.6} fill="none" />
          <path d={`M${w * 0.72},${cy + 7} L${w * 0.28},${cy + 7}`} stroke={STROKE} strokeWidth={1.6} />
          <path d={`M${w * 0.28},${cy + 7} l6,-4 m-6,4 l6,4`} stroke={STROKE} strokeWidth={1.6} fill="none" />
          <line x1={5} y1={cy} x2={2} y2={cy} stroke={STROKE} strokeWidth={2} />
          <line x1={w - 5} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'variable_speed_pump': {
      const r = Math.min(w, h) * 0.32
      const cy = h * 0.55
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          <circle cx={w / 2} cy={cy} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.6} />
          <path d={`M${w / 2},${cy} L${w / 2 + r * 0.55},${cy - r * 0.35}`} stroke={STROKE_HI} strokeWidth={1.5} />
          {/* VFD speed bars */}
          {[0, 1, 2].map((i) => (
            <line
              key={i}
              x1={w * 0.18 + i * 4}
              y1={h * 0.22}
              x2={w * 0.18 + i * 4}
              y2={h * 0.22 - (i + 1) * 3}
              stroke={STROKE_HI}
              strokeWidth={1.6}
            />
          ))}
        </g>
      )
    }
    case 'fan_coil': {
      const fx = w * 0.34
      const fy = h * 0.42
      const r = Math.min(w, h) * 0.18
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 12} rx={6} {...body} />
          {/* fan */}
          <circle cx={fx} cy={fy} r={r} fill="#0c1119" stroke={STROKE} strokeWidth={1.3} />
          {[0, 1, 2].map((i) => {
            const a = (i * 2 * Math.PI) / 3
            return (
              <path
                key={i}
                d={`M${fx},${fy} q${Math.cos(a) * r * 0.8},${Math.sin(a) * r * 0.3} ${Math.cos(a + 0.7) * r * 0.8},${Math.sin(a + 0.7) * r * 0.8}`}
                stroke={STROKE_HI}
                strokeWidth={1.2}
                fill="none"
              />
            )
          })}
          {/* coil wiggle */}
          <path
            d={`M${w * 0.5},${h - 12} q5,-6 10,0 q5,6 10,0 q5,-6 10,0`}
            fill="none"
            stroke="#b85563"
            strokeWidth={1.8}
            opacity={0.85}
          />
        </g>
      )
    }
    case 'towel_rail': {
      const x0 = w * 0.34
      const x1 = w * 0.66
      const rungs = 5
      return (
        <g>
          <line x1={x0} y1={8} x2={x0} y2={h - 8} stroke={STROKE} strokeWidth={1.8} />
          <line x1={x1} y1={8} x2={x1} y2={h - 8} stroke={STROKE} strokeWidth={1.8} />
          {Array.from({ length: rungs }).map((_, i) => {
            const y = 12 + (i * (h - 24)) / (rungs - 1)
            return <line key={i} x1={x0} y1={y} x2={x1} y2={y} stroke={STROKE_HI} strokeWidth={1.5} opacity={0.85} />
          })}
        </g>
      )
    }
    case 'air_handler': {
      const fx = w * 0.66
      const fy = h * 0.5
      const r = Math.min(w, h) * 0.18
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 12} rx={5} {...body} />
          {/* filter hatching on left */}
          <rect x={10} y={11} width={w * 0.3} height={h - 22} rx={2} fill={FILL_HI} stroke={STROKE} strokeWidth={1.1} />
          {[0, 1, 2, 3].map((i) => (
            <line key={i} x1={10} y1={11 + i * ((h - 22) / 3)} x2={10 + w * 0.3} y2={11 + (i + 1) * ((h - 22) / 3)} stroke={STROKE} strokeWidth={0.9} opacity={0.6} />
          ))}
          {/* fan */}
          <circle cx={fx} cy={fy} r={r} fill="#0c1119" stroke={STROKE} strokeWidth={1.3} />
          {[0, 1, 2].map((i) => {
            const a = (i * 2 * Math.PI) / 3
            return (
              <path
                key={i}
                d={`M${fx},${fy} q${Math.cos(a) * r * 0.8},${Math.sin(a) * r * 0.3} ${Math.cos(a + 0.7) * r * 0.8},${Math.sin(a + 0.7) * r * 0.8}`}
                stroke={STROKE_HI}
                strokeWidth={1.2}
                fill="none"
              />
            )
          })}
        </g>
      )
    }
    case 'combi_cylinder': {
      const strat = result?.strat
      const topR = w * 0.4
      return (
        <g>
          <defs>
            <linearGradient id={`tank-${uid}`} x1="0" y1="0" x2="0" y2="1">
              {strat
                ? strat.map((t, i) => (
                    <stop key={i} offset={`${(i / (strat.length - 1)) * 100}%`} stopColor={tempColor(t)} />
                  ))
                : [
                    <stop key="a" offset="0%" stopColor="#9aa6b6" />,
                    <stop key="b" offset="100%" stopColor="#6b7686" />,
                  ]}
            </linearGradient>
          </defs>
          <rect x={w / 2 - topR} y={8} width={topR * 2} height={h - 16} rx={topR * 0.55} fill={`url(#tank-${uid})`} stroke={STROKE} strokeWidth={1.5} opacity={strat ? 0.92 : 0.5} />
          <ellipse cx={w / 2} cy={12} rx={topR} ry={5} fill="#0e141e" stroke={STROKE} strokeWidth={1.2} />
          {/* internal coil */}
          <path d={`M${w / 2 - 6},${20} q12,${(h - 40) / 3} 0,${(h - 40) / 1.5} q-12,${(h - 40) / 3} 0,${(h - 40) / 1.5}`} fill="none" stroke="#0c1119" strokeWidth={2.2} opacity={0.55} />
          {/* hot-water tap at top */}
          <line x1={w / 2} y1={8} x2={w / 2} y2={4} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2} y1={4} x2={w / 2 + 7} y2={4} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + 7} y1={4} x2={w / 2 + 7} y2={8} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'thermal_store': {
      const strat = result?.strat
      const topR = w * 0.38
      return (
        <g>
          <defs>
            <linearGradient id={`tank-${uid}`} x1="0" y1="0" x2="0" y2="1">
              {strat
                ? strat.map((t, i) => (
                    <stop key={i} offset={`${(i / (strat.length - 1)) * 100}%`} stopColor={tempColor(t)} />
                  ))
                : [
                    <stop key="a" offset="0%" stopColor="#9aa6b6" />,
                    <stop key="b" offset="100%" stopColor="#6b7686" />,
                  ]}
            </linearGradient>
          </defs>
          <rect x={w / 2 - topR} y={5} width={topR * 2} height={h - 10} rx={topR * 0.5} fill={`url(#tank-${uid})`} stroke={STROKE} strokeWidth={1.5} opacity={strat ? 0.92 : 0.5} />
          <ellipse cx={w / 2} cy={9} rx={topR} ry={4.5} fill="#0e141e" stroke={STROKE} strokeWidth={1.2} />
          {/* two internal coils */}
          <path d={`M${w / 2 - 6},${16} q11,${(h - 32) / 5} 0,${(h - 32) / 2.5} q-11,${(h - 32) / 5} 0,${(h - 32) / 2.5}`} fill="none" stroke="#b85563" strokeWidth={2} opacity={0.6} />
          <path d={`M${w / 2 - 6},${h * 0.55} q11,${(h - 32) / 5} 0,${(h - 32) / 2.5} q-11,${(h - 32) / 5} 0,${(h - 32) / 2.5}`} fill="none" stroke="#4671c4" strokeWidth={2} opacity={0.6} />
        </g>
      )
    }
    case 'low_loss_header': {
      return (
        <g>
          <rect x={w / 2 - 9} y={6} width={18} height={h - 12} rx={9} {...body} />
          {[0.3, 0.5, 0.7].map((p, i) => (
            <circle key={i} cx={w / 2} cy={6 + (h - 12) * p} r={1.8} fill={STROKE} opacity={0.6} />
          ))}
          <line x1={w / 2 - 9} y1={h * 0.28} x2={5} y2={h * 0.28} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 - 9} y1={h * 0.72} x2={5} y2={h * 0.72} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + 9} y1={h * 0.28} x2={w - 5} y2={h * 0.28} stroke={STROKE} strokeWidth={2} />
          <line x1={w / 2 + 9} y1={h * 0.72} x2={w - 5} y2={h * 0.72} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'ufh_manifold': {
      const loops = 3
      return (
        <g>
          {/* supply + return bars */}
          <rect x={4} y={h * 0.2} width={w - 8} height={5} rx={2.5} fill="#b85563" opacity={0.8} stroke="none" />
          <rect x={4} y={h * 0.36} width={w - 8} height={5} rx={2.5} fill="#4671c4" opacity={0.8} stroke="none" />
          {Array.from({ length: loops }).map((_, i) => {
            const x = w * 0.2 + (i * (w * 0.6)) / (loops - 1)
            return (
              <path
                key={i}
                d={`M${x - 4},${h * 0.25} L${x - 4},${h - 8} q0,4 4,4 q4,0 4,-4 L${x + 4},${h * 0.41}`}
                fill="none"
                stroke={STROKE}
                strokeWidth={1.5}
              />
            )
          })}
        </g>
      )
    }
    case 'diverter_valve': {
      const cx = w / 2
      const cy = h * 0.5
      const r = Math.min(w, h) * 0.3
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          <circle cx={cx} cy={cy} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.6} />
          {/* T of ports */}
          <path d={`M${cx},${cy} L${cx - r},${cy} M${cx},${cy} L${cx + r},${cy} M${cx},${cy} L${cx},${cy + r}`} stroke={STROKE_HI} strokeWidth={1.7} />
          <circle cx={cx} cy={cy} r={2.2} fill={STROKE_HI} />
          {/* flow arrow */}
          <path d={`M${cx + r + 3},${cy - 7} l6,4 l-6,4`} fill="none" stroke={STROKE} strokeWidth={1.4} />
        </g>
      )
    }
    case 'zone_valve': {
      const cy = h * 0.58
      const cx = w / 2
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* bowtie valve */}
          <path d={`M${cx - 11},${cy - 8} L${cx + 11},${cy + 8} L${cx + 11},${cy - 8} L${cx - 11},${cy + 8} Z`} fill="none" stroke={STROKE} strokeWidth={1.5} />
          {/* square actuator on top */}
          <rect x={cx - 7} y={cy - 22} width={14} height={11} rx={2} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <line x1={cx} y1={cy - 11} x2={cx} y2={cy - 8} stroke={STROKE} strokeWidth={1.5} />
        </g>
      )
    }
    case 'thermostatic_valve': {
      const cy = h * 0.6
      const cx = w / 2
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* bowtie valve */}
          <path d={`M${cx - 11},${cy - 8} L${cx + 11},${cy + 8} L${cx + 11},${cy - 8} L${cx - 11},${cy + 8} Z`} fill="none" stroke={STROKE} strokeWidth={1.5} />
          {/* sensor bulb / dome on top (TRV) */}
          <path d={`M${cx - 7},${cy - 10} a7,9 0 0 1 14,0 Z`} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          {[0.35, 0.6, 0.85].map((p, i) => (
            <line key={i} x1={cx - 4} y1={cy - 10 - (cy - 10 - (cy - 22)) * p} x2={cx + 4} y2={cy - 10 - (cy - 10 - (cy - 22)) * p} stroke={STROKE} strokeWidth={0.9} opacity={0.6} />
          ))}
        </g>
      )
    }
    case 'balancing_valve': {
      const cy = h * 0.58
      const cx = w / 2
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* bowtie valve */}
          <path d={`M${cx - 11},${cy - 8} L${cx + 11},${cy + 8} L${cx + 11},${cy - 8} L${cx - 11},${cy + 8} Z`} fill="none" stroke={STROKE} strokeWidth={1.5} />
          {/* setting knob with tick */}
          <circle cx={cx} cy={cy - 16} r={6} fill={FILL_HI} stroke={STROKE} strokeWidth={1.4} />
          <line x1={cx} y1={cy - 16} x2={cx} y2={cy - 21} stroke={STROKE_HI} strokeWidth={1.5} />
          <line x1={cx} y1={cy - 10} x2={cx} y2={cy - 8} stroke={STROKE} strokeWidth={1.4} />
        </g>
      )
    }
    case 'check_valve': {
      const cy = h / 2
      const cx = w / 2
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* body */}
          <circle cx={cx} cy={cy} r={Math.min(w, h) * 0.28} fill={FILL_HI} stroke={STROKE} strokeWidth={1.5} />
          {/* flap */}
          <line x1={cx - 5} y1={cy + 6} x2={cx + 4} y2={cy - 6} stroke={STROKE_HI} strokeWidth={1.6} />
          <line x1={cx - 5} y1={cy - 6} x2={cx - 5} y2={cy + 6} stroke={STROKE} strokeWidth={1.3} />
          {/* one-way flow arrow */}
          <path d={`M${cx + 8},${cy - 6} l5,6 l-5,6`} fill="none" stroke={STROKE} strokeWidth={1.4} />
        </g>
      )
    }
    case 'pressure_relief': {
      const cy = h * 0.6
      const cx = w * 0.42
      return (
        <g>
          <line x1={2} y1={cy} x2={cx} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* valve body (bowtie) */}
          <path d={`M${cx - 9},${cy - 7} L${cx + 9},${cy + 7} L${cx + 9},${cy - 7} L${cx - 9},${cy + 7} Z`} fill="none" stroke={STROKE} strokeWidth={1.5} />
          {/* spring zigzag */}
          <polyline
            points={`${cx},${cy - 7} ${cx - 4},${cy - 12} ${cx + 4},${cy - 16} ${cx - 4},${cy - 20} ${cx + 4},${cy - 24} ${cx},${cy - 28}`}
            fill="none"
            stroke={STROKE_HI}
            strokeWidth={1.3}
          />
          {/* angled outlet stub */}
          <line x1={cx + 9} y1={cy} x2={w - 5} y2={cy - h * 0.22} stroke={STROKE} strokeWidth={2} />
        </g>
      )
    }
    case 'strainer': {
      const cy = h * 0.42
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          {/* Y body leg */}
          <path d={`M${w * 0.42},${cy} L${w * 0.66},${h - 6}`} stroke={STROKE} strokeWidth={3} />
          {/* mesh hatch in the leg */}
          <g stroke={STROKE_HI} strokeWidth={0.9} opacity={0.7}>
            <line x1={w * 0.46} y1={cy + 6} x2={w * 0.56} y2={cy + 10} />
            <line x1={w * 0.5} y1={cy + 4} x2={w * 0.62} y2={cy + 14} />
            <line x1={w * 0.54} y1={cy + 8} x2={w * 0.6} y2={cy + 18} />
          </g>
        </g>
      )
    }
    case 'flow_meter': {
      const cy = h / 2
      const cx = w / 2
      const r = Math.min(w, h) * 0.22
      return (
        <g>
          <line x1={2} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
          <rect x={cx - r - 4} y={cy - r - 4} width={(r + 4) * 2} height={(r + 4) * 2} rx={3} fill={FILL_HI} stroke={STROKE} strokeWidth={1.3} />
          {/* rotor / turbine */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={STROKE} strokeWidth={1.2} />
          {[0, 1, 2, 3].map((i) => {
            const a = (i * Math.PI) / 2
            return <line key={i} x1={cx} y1={cy} x2={cx + Math.cos(a) * r} y2={cy + Math.sin(a) * r} stroke={STROKE_HI} strokeWidth={1.1} />
          })}
          <text x={cx} y={cy - r - 6} textAnchor="middle" fontSize={8} fill={STROKE_HI} fontFamily="monospace">F</text>
        </g>
      )
    }
    case 'heat_meter': {
      return (
        <g>
          <rect x={w / 2 - 16} y={h / 2 - 10} width={32} height={20} rx={3} {...body} />
          <rect x={w / 2 - 13} y={h / 2 - 7} width={26} height={14} rx={2} fill="#0c1119" stroke="none" />
          <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize={9} fill={STROKE_HI} fontFamily="monospace">kWh</text>
        </g>
      )
    }
    case 'pressure_gauge': {
      const cx = w / 2
      const cy = h * 0.46
      const r = Math.min(w, h) * 0.32
      return (
        <g>
          <circle cx={cx} cy={cy} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.5} />
          {/* needle */}
          <line x1={cx} y1={cy} x2={cx + r * 0.6} y2={cy - r * 0.6} stroke={STROKE_HI} strokeWidth={1.6} />
          <circle cx={cx} cy={cy} r={2} fill={STROKE_HI} />
          <text x={cx} y={cy + r + 8} textAnchor="middle" fontSize={8} fill={STROKE_HI} fontFamily="monospace">bar</text>
        </g>
      )
    }
    case 'weather_compensator': {
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 12} rx={6} {...body} />
          {/* display */}
          <rect x={10} y={11} width={w - 20} height={h * 0.32} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          {/* sun + cloud */}
          <circle cx={w * 0.38} cy={h * 0.68} r={Math.min(w, h) * 0.1} fill="none" stroke="#e8a23a" strokeWidth={1.3} />
          <path d={`M${w * 0.5},${h * 0.78} q3,-10 12,-5 q8,-2 8,5 Z`} fill={FILL_HI} stroke={STROKE} strokeWidth={1.2} />
        </g>
      )
    }
    case 'zone_controller': {
      const dx = w * 0.66
      const dy = h * 0.62
      const r = Math.min(w, h) * 0.13
      return (
        <g>
          <rect x={5} y={6} width={w - 10} height={h - 12} rx={6} {...body} />
          {/* display */}
          <rect x={10} y={11} width={w - 20} height={h * 0.32} rx={2} fill="#0c1119" stroke={STROKE} strokeWidth={1} />
          {/* dial */}
          <circle cx={dx} cy={dy} r={r} fill={FILL_HI} stroke={STROKE} strokeWidth={1.3} />
          <line x1={dx} y1={dy} x2={dx + r * 0.7} y2={dy - r * 0.7} stroke={STROKE_HI} strokeWidth={1.4} />
        </g>
      )
    }
    case 'tee': {
      const cy = h / 2
      const cx = w / 2
      return (
        <g>
          <line x1={4} y1={cy} x2={w - 4} y2={cy} stroke={STROKE} strokeWidth={3} />
          <line x1={cx} y1={cy} x2={cx} y2={h - 4} stroke={STROKE} strokeWidth={3} />
          <circle cx={4} cy={cy} r={2.4} fill={STROKE} />
          <circle cx={w - 4} cy={cy} r={2.4} fill={STROKE} />
          <circle cx={cx} cy={h - 4} r={2.4} fill={STROKE} />
        </g>
      )
    }
    case 'cross': {
      const cy = h / 2
      const cx = w / 2
      return (
        <g>
          <line x1={4} y1={cy} x2={w - 4} y2={cy} stroke={STROKE} strokeWidth={3} />
          <line x1={cx} y1={4} x2={cx} y2={h - 4} stroke={STROKE} strokeWidth={3} />
          <circle cx={4} cy={cy} r={2.4} fill={STROKE} />
          <circle cx={w - 4} cy={cy} r={2.4} fill={STROKE} />
          <circle cx={cx} cy={4} r={2.4} fill={STROKE} />
          <circle cx={cx} cy={h - 4} r={2.4} fill={STROKE} />
        </g>
      )
    }
    case 'elbow': {
      const cx = w * 0.34
      const cy = h * 0.66
      return (
        <g>
          {/* 90deg rounded bend: up from bottom, curve out to the right */}
          <path d={`M${cx},${h - 4} L${cx},${cy} Q${cx},${cy - 8} ${cx + 8},${cy - 8} L${w - 4},${cy - 8}`} fill="none" stroke={STROKE} strokeWidth={3} />
          <circle cx={cx} cy={h - 4} r={2.4} fill={STROKE} />
          <circle cx={w - 4} cy={cy - 8} r={2.4} fill={STROKE} />
        </g>
      )
    }
    case 'reducer': {
      const cy = h / 2
      const big = h * 0.34
      const small = h * 0.16
      const xl = w * 0.32
      const xr = w * 0.68
      return (
        <g>
          <line x1={2} y1={cy} x2={xl} y2={cy} stroke={STROKE} strokeWidth={3} />
          <path
            d={`M${xl},${cy - big} L${xr},${cy - small} L${xr},${cy + small} L${xl},${cy + big} Z`}
            fill={FILL_HI}
            stroke={STROKE}
            strokeWidth={1.5}
          />
          <line x1={xr} y1={cy} x2={w - 2} y2={cy} stroke={STROKE} strokeWidth={3} />
        </g>
      )
    }
    default:
      return <rect x={5} y={5} width={w - 10} height={h - 10} rx={6} {...body} />
  }
}

import { EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { tempColor, LINE_COLORS } from '../../model/colors'
import { useAppSelector } from '../../store/hooks'
import { formatTemp } from '../../store/uiSlice'
import type { RFEdge } from '../../store/factory'

function PipeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<RFEdge>) {
  const showLabels = useAppSelector((s) => s.ui.showLabels)
  const tempUnit = useAppSelector((s) => s.ui.tempUnit)
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  })

  const result = data?.result
  const temp = result?.tempC
  const flow = result?.flowM3h ?? 0
  const color =
    temp !== undefined
      ? tempColor(temp)
      : data?.line === 'supply'
        ? LINE_COLORS.hot
        : data?.line === 'return'
          ? LINE_COLORS.cold
          : LINE_COLORS.idle
  const width = Math.max(2, Math.min(6, 2 + flow * 1.15))
  const flowing = flow > 0.03
  const dir = result?.dir ?? 1
  // higher flow -> shorter period -> faster particles
  const period = Math.max(0.45, Math.min(6, 7 / (flow + 0.4)))
  const showLabel = (showLabels && flowing && temp !== undefined) || !!selected

  // Static directional chevron at the pipe midpoint so flow direction is
  // readable even when the particle animation is paused or reduced-motion is on.
  // Orient along the dominant source→target axis (smoothstep legs are
  // orthogonal), then flip by the solved direction (dir: +1 fwd, -1 reverse).
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const baseAngle =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : 270
  const arrowAngle = dir < 0 ? baseAngle + 180 : baseAngle
  const aLen = Math.max(4, Math.min(7, width + 2))

  return (
    <>
      {/* invisible wide hit area so the thin pipe is easy to click / select */}
      <path
        className="react-flow__edge-interaction"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
      />
      <path
        id={id}
        className="react-flow__edge-path"
        d={path}
        fill="none"
        // inline style (not the stroke attribute) so it overrides React Flow's
        // base `.react-flow__edge-path { stroke: #b1b1b7 }` rule — a CSS rule
        // beats an SVG presentation attribute, which otherwise greys every pipe.
        style={{
          stroke: color,
          strokeWidth: selected ? width + 1.2 : width,
          strokeOpacity: flowing ? 0.95 : 0.5,
        }}
      />
      {flowing && (
        <path
          d={path}
          className="pipe-particles"
          strokeWidth={Math.max(2.2, width * 0.7)}
          strokeLinecap="round"
          fill="none"
          strokeDasharray="0.5 11"
          style={{
            // dark droplets so the moving water reads against the bright,
            // temperature-coloured pipe (inline style beats any class rule)
            stroke: '#0a1020',
            strokeOpacity: 0.85,
            animationDuration: `${period}s`,
            animationDirection: dir < 0 ? 'reverse' : 'normal',
          }}
        />
      )}
      {flowing && (
        // chevron arrowhead pointing along the solved flow direction
        <g
          transform={`translate(${labelX} ${labelY}) rotate(${arrowAngle})`}
          style={{ pointerEvents: 'none' }}
          aria-hidden="true"
        >
          <path
            d={`M ${-aLen} ${-aLen} L ${aLen} 0 L ${-aLen} ${aLen}`}
            fill="none"
            stroke="#0a1020"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
          />
        </g>
      )}
      {showLabel && temp !== undefined && (
        <EdgeLabelRenderer>
          <div
            className="pipe-label nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY + (flowing ? 13 : 0)}px)`,
              color: tempColor(temp),
              border: `1px solid ${tempColor(temp)}44`,
            }}
          >
            {formatTemp(temp, tempUnit)}
            {flow > 0.001 && (
              <span style={{ opacity: 0.8, fontWeight: 500 }}> · {(flow * 1000 / 60).toFixed(1)} L/min</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default PipeEdge

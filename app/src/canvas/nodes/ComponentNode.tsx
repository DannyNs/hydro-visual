import { memo, useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import { CATALOG, isToggleable } from '../../model/catalog'
import type { Port } from '../../model/types'
import { tempColor, LINE_COLORS } from '../../model/colors'
import { Glyph } from '../glyphs'
import type { RFNode } from '../../store/factory'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import { formatTemp, convertTemp, type TempUnit } from '../../store/uiSlice'
import { removeNode } from '../../store/actions'
import { setNodeEnabled } from '../../store/graphSlice'
import { useT } from '../../i18n/useT'

const sideToPosition: Record<Port['side'], Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}

function handleStyle(port: Port): CSSProperties {
  const pos: CSSProperties =
    port.side === 'left' || port.side === 'right'
      ? { top: `${port.offset * 100}%` }
      : { left: `${port.offset * 100}%` }
  // colour the connection by side: red = hot (supply), blue = cold (return)
  if (port.hint === 'supply')
    return { ...pos, background: LINE_COLORS.hot, borderColor: LINE_COLORS.hot }
  if (port.hint === 'return')
    return { ...pos, background: LINE_COLORS.cold, borderColor: LINE_COLORS.cold }
  return pos
}

function specLine(
  kind: string,
  params: Record<string, number>,
  unit: TempUnit,
  result?: RFNode['data']['result'],
): string {
  switch (kind) {
    case 'heat_pump':
      return result?.cop
        ? `${params.ratedKw} kW · COP ${result.cop.toFixed(2)}`
        : `${params.ratedKw} kW`
    case 'gas_boiler':
      return `${params.ratedKw} kW`
    case 'buffer_tank':
    case 'dhw_cylinder':
      return `${params.volumeL} L`
    case 'radiator':
    case 'underfloor':
      return result?.heatKw ? `${result.heatKw.toFixed(1)} kW` : `${params.ratedKw} kW`
    case 'circulator':
    case 'direct_group':
    case 'mixing_group':
    case 'injection_group':
      return result?.supplyC ? formatTemp(result.supplyC, unit) : `${params.qMaxM3h} m³/h`
    default:
      return ''
  }
}

function ComponentNode({ id, data, selected }: NodeProps<RFNode>) {
  const dispatch = useAppDispatch()
  const updateNodeInternals = useUpdateNodeInternals()
  const unit = useAppSelector((s) => s.ui.tempUnit)
  const { comp, t, describe } = useT()
  const def = CATALOG[data.kind]
  const portTitle = (port: Port): string => {
    const name = port.label ?? port.id
    if (port.hint === 'supply') return `${name} — ${t('port.hot')}`
    if (port.hint === 'return') return `${name} — ${t('port.cold')}`
    return name
  }
  // show the localised name when the label is still the default (unchanged
  // English catalog label); keep the user's custom name once renamed.
  const displayName = data.label === def.label ? comp(data.kind) : data.label
  const { w, h } = def.size
  const result = data.result
  const off = data.enabled === false
  // red pulsing ring when this node is one of the fighting pumps (Option B)
  const fighting = useAppSelector((s) => s.sim.warnings.some((w) => w.nodeIds?.includes(id)))
  const canToggle = isToggleable(data.kind)
  const chip = result?.supplyC
  const ports = def.dynamicPorts ? def.dynamicPorts(data.params) : def.ports

  // when the handle set changes (configurable tappings / circuits), React Flow
  // must re-measure or the new handles render but aren't connectable.
  const portSig = ports.map((p) => p.id).join(',')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, portSig, updateNodeInternals])

  return (
    <div
      className={`cnode${selected ? ' sel' : ''}${off ? ' off' : ''}${fighting ? ' fight' : ''}`}
      style={{ width: w, height: h }}
      title={describe(data.kind)}
    >
      {canToggle && (selected || off) && (
        <button
          className={`node-power nodrag${off ? ' off' : ''}`}
          title={t('power.hint')}
          aria-label={t('power.hint')}
          aria-pressed={!off}
          onClick={(e) => {
            e.stopPropagation()
            dispatch(setNodeEnabled({ nodeId: id, enabled: off }))
          }}
        >
          ⏻
        </button>
      )}
      {selected && (
        <button
          className="node-del nodrag"
          title={`${t('info.removeComponent')} (Del)`}
          aria-label={`${t('info.removeComponent')} ${displayName}`}
          onClick={(e) => {
            e.stopPropagation()
            dispatch(removeNode(id))
          }}
        >
          ×
        </button>
      )}
      {off ? (
        <span className="chip off-pill">{t('power.badge')}</span>
      ) : (
        chip !== undefined &&
        chip > 0 && (
          <span
            className="chip"
            style={{ color: tempColor(chip), border: `1px solid ${tempColor(chip)}55` }}
          >
            {convertTemp(chip, unit).toFixed(1)} °{unit}
          </span>
        )
      )}
      <div className="glyph">
        <Glyph kind={data.kind} w={w} h={h} result={result} params={data.params} uid={id} />
      </div>
      {ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={sideToPosition[port.side]}
          style={handleStyle(port)}
          title={portTitle(port)}
          isConnectable
        />
      ))}
      <div className="name" style={{ maxWidth: Math.max(w + 36, 96) }}>
        <b title={displayName}>{displayName}</b>
        {off ? (
          <span className="off-text">{t('power.off')}</span>
        ) : (
          specLine(data.kind, data.params, unit, result) && (
            <span>{specLine(data.kind, data.params, unit, result)}</span>
          )
        )}
      </div>
    </div>
  )
}

export default memo(ComponentNode)

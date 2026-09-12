import { useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionMode,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import {
  nodesChanged,
  edgesChanged,
  connected,
  addComponent,
} from '../store/graphSlice'
import { selectNode, selectEdge, clearSelection } from '../store/selectionSlice'
import { useT } from '../i18n/useT'
import type { ComponentKind } from '../model/types'
import ComponentNode from './nodes/ComponentNode'
import PipeEdge from './edges/PipeEdge'
import type { RFNode } from '../store/factory'

const nodeTypes = { component: ComponentNode }
const edgeTypes = { pipe: PipeEdge }

const MINI_COLORS: Record<string, string> = {
  source: '#d6a533',
  emitter: '#e5484d',
  pump: '#3b82f6',
  tank: '#2dd4bf',
  junction: '#8b5cf6',
  valve: '#a855f7',
  passive: '#46566b',
}

export const DRAG_KEY = 'application/hydro-kind'

export default function CanvasEditor() {
  const dispatch = useAppDispatch()
  const { t } = useT()
  const nodes = useAppSelector((s) => s.graph.nodes)
  const edges = useAppSelector((s) => s.graph.edges)
  const { screenToFlowPosition } = useReactFlow()

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => dispatch(nodesChanged(changes)),
    [dispatch],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => dispatch(edgesChanged(changes)),
    [dispatch],
  )
  const onConnect = useCallback(
    (c: Connection) => dispatch(connected(c)),
    [dispatch],
  )
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => dispatch(selectNode(node.id)),
    [dispatch],
  )
  const onEdgeClick = useCallback<EdgeMouseHandler>(
    (_, edge) => dispatch(selectEdge(edge.id)),
    [dispatch],
  )
  const onPaneClick = useCallback(() => dispatch(clearSelection()), [dispatch])

  // live feedback while dragging a pipe: forbid wiring a component back to itself
  const isValidConnection = useCallback(
    (c: Connection | { source: string | null; target: string | null }) =>
      !!c.source && !!c.target && c.source !== c.target,
    [],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData(DRAG_KEY) as ComponentKind
      if (!kind) return
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      dispatch(addComponent({ kind, x: Math.round(pos.x), y: Math.round(pos.y) }))
    },
    [dispatch, screenToFlowPosition],
  )

  return (
    <>
    <ReactFlow
      aria-label="System schematic canvas — drag components in and connect their supply and return ports"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onPaneClick={onPaneClick}
      onDelete={() => dispatch(clearSelection())}
      deleteKeyCode={['Delete', 'Backspace']}
      onDragOver={onDragOver}
      onDrop={onDrop}
      connectionMode={ConnectionMode.Loose}
      minZoom={0.08}
      maxZoom={2.5}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'pipe' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#17202d" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => {
          const role = (n as RFNode).data ? roleColor((n as RFNode).data.kind) : '#46566b'
          return role
        }}
        maskColor="#0a0e14cc"
      />
    </ReactFlow>
      {nodes.length === 0 && (
        <div className="canvas-empty">
          <h3>{t('empty.title')}</h3>
          <p>{t('empty.body')}</p>
          <p>{t('empty.note')}</p>
        </div>
      )}
    </>
  )
}

import { CATALOG } from '../model/catalog'
function roleColor(kind: ComponentKind): string {
  return MINI_COLORS[CATALOG[kind].role] ?? '#46566b'
}

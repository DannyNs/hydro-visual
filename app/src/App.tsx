import { useEffect, useRef, useState } from 'react'
import { createSelector } from '@reduxjs/toolkit'
import { ReactFlowProvider } from '@xyflow/react'
import { useAppDispatch, useAppSelector } from './store/hooks'
import { runSimulation, runTransient, recomputeTransient, applyFrame } from './store/run'
import { setEngine } from './store/simSlice'
import { setSimT, pause, clearFrames } from './store/playbackSlice'
import { store, type RootState } from './store/store'
import { duplicateNodes, replaceGraph } from './store/graphSlice'
import { undo, redo } from './store/history'
import { downloadGraph, pickGraphFile } from './store/io'
import { onEngineReady } from './solver/client'
import { useT } from './i18n/useT'
import TopBar from './components/TopBar'
import Palette from './components/Palette'
import CanvasEditor from './canvas/CanvasEditor'
import { LAYOUT_VARIANT_COUNT } from './store/layout'
import RightPanel from './components/RightPanel'
import ChartsPanel from './components/ChartsPanel'
import StatusBar from './components/StatusBar'
import TransportBar from './components/TransportBar'
import type { RFNode, RFEdge } from './store/factory'

// Signature of everything that affects a steady solve (NOT results/positions).
function solveSig(nodes: RFNode[], edges: RFEdge[]): string {
  const n = nodes
    .map(
      (nd) =>
        `${nd.id}:${nd.data.kind}:${nd.data.enabled === false ? 'off' : 'on'}:${Object.entries(
          nd.data.params,
        )
          .map(([k, v]) => k + v)
          .join(',')}`,
    )
    .join('|')
  const e = edges
    .map(
      (ed) =>
        `${ed.id}:${ed.source}.${ed.sourceHandle}>${ed.target}.${ed.targetHandle}:${ed.data?.lengthM},${ed.data?.diameterMm}`,
    )
    .join('|')
  return `${n}#${e}`
}

// Topology-only signature: connectivity + on/off state, but NOT params. Used by
// steady-manual mode to auto-refresh when the physical layout changes (a node is
// added/removed or a valve/pump is toggled) so the canvas never shows stale flow —
// e.g. water still flowing through a valve you just closed. Param tweaks stay
// manual there (press Run), which keeps batching edits cheap.
function topoSig(nodes: RFNode[], edges: RFEdge[]): string {
  const n = nodes
    .map((nd) => `${nd.id}:${nd.data.kind}:${nd.data.enabled === false ? 'off' : 'on'}`)
    .join('|')
  const e = edges
    .map((ed) => `${ed.id}:${ed.source}.${ed.sourceHandle}>${ed.target}.${ed.targetHandle}`)
    .join('|')
  return `${n}#${e}`
}

// Memoized: the O(nodes+edges) string build runs only when the graph arrays
// actually change, not on every store dispatch (playback ticks ~60/s).
const selectSolveSig = createSelector(
  (s: RootState) => s.graph.nodes,
  (s: RootState) => s.graph.edges,
  solveSig,
)
const selectTopoSig = createSelector(
  (s: RootState) => s.graph.nodes,
  (s: RootState) => s.graph.edges,
  topoSig,
)

export default function App() {
  const dispatch = useAppDispatch()
  const { t } = useT()
  const simMode = useAppSelector((s) => s.ui.simMode)
  const warnings = useAppSelector((s) => s.sim.warnings)
  const sig = useAppSelector(selectSolveSig)
  const topo = useAppSelector(selectTopoSig)
  const playing = useAppSelector((s) => s.playback.playing)
  const speed = useAppSelector((s) => s.playback.speed)
  const frameCount = useAppSelector((s) => s.playback.frames.length)
  const arrange = useAppSelector((s) => s.ui.arrange)
  const [arrangeToast, setArrangeToast] = useState('')
  const timer = useRef<number | undefined>(undefined)

  // engine readiness from the worker (unsubscribe on cleanup so StrictMode's
  // double-mount doesn't accumulate listeners)
  useEffect(() => onEngineReady((engine) => dispatch(setEngine(engine))), [dispatch])

  // keyboard shortcuts: undo/redo, duplicate, export, import
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        dispatch(undo())
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        dispatch(redo())
      } else if (k === 'd') {
        e.preventDefault()
        const st = store.getState()
        const ids = st.graph.nodes.filter((n) => n.selected).map((n) => n.id)
        if (!ids.length && st.selection.nodeId) ids.push(st.selection.nodeId)
        if (ids.length) dispatch(duplicateNodes(ids))
      } else if (k === 'e') {
        e.preventDefault()
        const g = store.getState().graph
        downloadGraph({ nodes: g.nodes, edges: g.edges })
      } else if (k === 'o') {
        e.preventDefault()
        void pickGraphFile().then((g) => {
          if (g) dispatch(replaceGraph(g))
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

  // steady auto-solve (Live mode only), debounced
  useEffect(() => {
    if (simMode !== 'steady-live') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void dispatch(runSimulation()), 220)
    return () => window.clearTimeout(timer.current)
  }, [sig, simMode, dispatch])

  // steady-manual: re-solve when the TOPOLOGY changes (node added/removed or a
  // valve/pump toggled) so stale flows never linger — e.g. a just-closed valve must
  // stop showing flow immediately. Param-only edits stay manual (press Run).
  useEffect(() => {
    if (simMode !== 'steady-manual') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void dispatch(runSimulation()), 220)
    return () => window.clearTimeout(timer.current)
  }, [topo, simMode, dispatch])

  // entering transient computes the cold-start run; leaving restores the steady view
  useEffect(() => {
    if (simMode === 'transient') {
      void dispatch(runTransient())
    } else {
      dispatch(clearFrames())
      void dispatch(runSimulation())
    }
  }, [simMode, dispatch])

  // While in charge-up mode, an edit (toggle a pump/valve/heater, change a param)
  // must re-solve the time-march so the change takes effect — resuming from the
  // current warm state, not restarting cold. Debounced; the first run after entry
  // is the cold start above, so skip that one.
  const transientPrimed = useRef(false)
  useEffect(() => {
    if (simMode !== 'transient') {
      transientPrimed.current = false
      return
    }
    if (!transientPrimed.current) {
      transientPrimed.current = true // entry render — cold start already dispatched
      return
    }
    const id = window.setTimeout(() => void dispatch(recomputeTransient()), 260)
    return () => window.clearTimeout(id)
  }, [sig, simMode, dispatch])

  // Real-time playback driver: advance a SIMULATED clock by (wall-clock Δ × speed)
  // so a cold-start plays out at a realistic pace (1× = real time, 60× = one
  // simulated minute per real second). The shown frame is re-applied only when the
  // clock crosses into a new frame, so the canvas updates exactly as fast as the
  // recorded frames change while the clock itself ticks smoothly.
  useEffect(() => {
    if (!playing || frameCount < 2) return
    let raf = 0
    let last = 0
    let lastIdx = store.getState().playback.idx
    let simT = store.getState().playback.simT
    const endT = store.getState().playback.endT
    const tick = (ts: number) => {
      if (!last) last = ts
      simT += ((ts - last) / 1000) * speed
      last = ts
      const done = simT >= endT
      dispatch(setSimT(done ? endT : simT))
      const i = store.getState().playback.idx
      if (i !== lastIdx) {
        dispatch(applyFrame(i))
        lastIdx = i
      }
      if (done) {
        dispatch(applyFrame(lastIdx))
        dispatch(pause())
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, frameCount, dispatch])

  // brief toast telling the user which auto-arrange variant they're now seeing
  // (the button cycles through them on each click)
  useEffect(() => {
    if (arrange.seq === 0) return
    setArrangeToast(t('tb.arranged', { n: arrange.variant + 1, total: LAYOUT_VARIANT_COUNT }))
    const id = window.setTimeout(() => setArrangeToast(''), 1600)
    return () => window.clearTimeout(id)
  }, [arrange.seq, arrange.variant, t])

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <div className="main">
          <Palette />
          <div style={{ position: 'relative', minWidth: 0 }}>
            <CanvasEditor />
            {warnings.length > 0 && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  right: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  pointerEvents: 'none',
                  zIndex: 5,
                }}
              >
                {warnings.slice(0, 4).map((w, i) => (
                  <div
                    key={i}
                    style={{
                      alignSelf: 'flex-start',
                      maxWidth: '70%',
                      padding: '5px 10px',
                      borderRadius: 7,
                      fontSize: 12,
                      fontWeight: 600,
                      color: w.level === 'error' ? '#ffd4d4' : '#ffe9c2',
                      background:
                        w.level === 'error' ? 'rgba(120,20,24,0.92)' : 'rgba(110,75,10,0.92)',
                      border: `1px solid ${w.level === 'error' ? '#e5484d' : '#d9a514'}`,
                      boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                    }}
                  >
                    <span aria-hidden="true">{w.level === 'error' ? '⛔' : '⚠'}</span>{' '}
                    {t(w.key, w.vars)}
                  </div>
                ))}
              </div>
            )}
            {arrangeToast && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  position: 'absolute',
                  top: 12,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  padding: '6px 14px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text)',
                  background: 'rgba(12,17,25,0.94)',
                  border: '1px solid var(--line-2)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                  zIndex: 6,
                }}
              >
                ▤ {arrangeToast}
              </div>
            )}
            {simMode === 'transient' && frameCount > 1 && <TransportBar />}
          </div>
          <RightPanel />
        </div>
        <ChartsPanel />
        <StatusBar />
      </div>
    </ReactFlowProvider>
  )
}

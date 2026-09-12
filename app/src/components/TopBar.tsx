import { useReactFlow } from '@xyflow/react'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { runSimulation, runTransient } from '../store/run'
import { loadSeed, clearGraph, replaceGraph } from '../store/graphSlice'
import { removeSelected, autoArrange } from '../store/actions'
import { undo, redo } from '../store/history'
import { downloadGraph, pickGraphFile } from '../store/io'
import { store } from '../store/store'
import { toggleLabels, setSimMode, toggleTempUnit, setLang, type SimMode } from '../store/uiSlice'
import { useT } from '../i18n/useT'
import { LANGS, persistLang, type Lang } from '../i18n'

export default function TopBar() {
  const dispatch = useAppDispatch()
  const { t } = useT()
  const running = useAppSelector((s) => s.sim.running)
  const engine = useAppSelector((s) => s.sim.engine)
  const showLabels = useAppSelector((s) => s.ui.showLabels)
  const simMode = useAppSelector((s) => s.ui.simMode)
  const tempUnit = useAppSelector((s) => s.ui.tempUnit)
  const computing = useAppSelector((s) => s.playback.computing)
  const hasSelection = useAppSelector((s) => !!(s.selection.nodeId || s.selection.edgeId))
  const canUndo = useAppSelector((s) => s.historyflags.canUndo)
  const canRedo = useAppSelector((s) => s.historyflags.canRedo)
  const lang = useAppSelector((s) => s.ui.lang)
  const rf = useReactFlow()
  const transient = simMode === 'transient'
  const exportDesign = () => {
    const g = store.getState().graph
    downloadGraph({ nodes: g.nodes, edges: g.edges })
  }
  const importDesign = () => void pickGraphFile().then((g) => g && dispatch(replaceGraph(g)))
  const arrange = () => {
    dispatch(autoArrange())
    // Frame the tidied graph at a READABLE zoom: clamp to [0.7, 1.0] so the
    // nodes never shrink to an unreadable size to fit everything — a large graph
    // stays readable and centred, and the user pans to see the rest. A longer
    // tick lets React Flow apply the new positions before framing.
    setTimeout(() => rf.fitView({ padding: 0.1, minZoom: 0.7, maxZoom: 1.0, duration: 400 }), 120)
  }

  return (
    <>
      <div className="menubar">
        <div className="logo" />
        <div className="title">{t('app.title')}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, color: 'var(--text-faint)' }}>
          <span className="engine-pill">{engine === 'loading' ? '…' : t('tb.engine', { engine: engine.toUpperCase() })}{engine === 'wasm' ? ' ✓' : ''}</span>
        </div>
      </div>

      <div className="toolbar" role="toolbar" aria-label={t('app.title')}>
        <button className="tbtn" title={t('tb.new')} aria-label={t('tb.new')} onClick={() => dispatch(clearGraph())}>
          {svgNew}
        </button>
        <button className="tbtn" title={t('tb.loadExample')} aria-label={t('tb.loadExample')} onClick={() => dispatch(loadSeed())}>
          {svgOpen}
        </button>
        <button className="tbtn" title={`${t('tb.export')} (Ctrl+E)`} aria-label={t('tb.export')} onClick={exportDesign}>
          {svgSave}
        </button>
        <button className="tbtn" title={`${t('tb.import')} (Ctrl+O)`} aria-label={t('tb.import')} onClick={importDesign}>
          ⤓
        </button>
        <div className="tsep" />
        <button className="tbtn" title={`${t('tb.undo')} (Ctrl+Z)`} aria-label={t('tb.undo')} disabled={!canUndo} onClick={() => dispatch(undo())}>↶</button>
        <button className="tbtn" title={`${t('tb.redo')} (Ctrl+Y)`} aria-label={t('tb.redo')} disabled={!canRedo} onClick={() => dispatch(redo())}>↷</button>
        <div className="tsep" />
        <button className="tbtn" title={t('tb.zoomOut')} aria-label={t('tb.zoomOut')} onClick={() => rf.zoomOut()}>－</button>
        <button className="tbtn" title={t('tb.zoomIn')} aria-label={t('tb.zoomIn')} onClick={() => rf.zoomIn()}>＋</button>
        <button className="tbtn" title={t('tb.fit')} aria-label={t('tb.fit')} onClick={() => rf.fitView({ padding: 0.18 })}>⤢</button>
        <button className="tbtn" title={t('tb.autoArrange')} aria-label={t('tb.autoArrange')} onClick={arrange}>{svgArrange}</button>
        <div className="tsep" />
        <button
          className="tbtn"
          title={t('tb.delete')}
          aria-label={t('tb.delete')}
          disabled={!hasSelection}
          style={hasSelection ? { color: 'var(--hot)', borderColor: '#5b2a2c' } : undefined}
          onClick={() => dispatch(removeSelected())}
        >
          🗑
        </button>
        <div className="tsep" />
        <button
          className="run-btn"
          aria-label={transient ? t('tb.runTransient') : t('tb.run')}
          title={t(`modeHelp.${simMode}`)}
          onClick={() => dispatch(transient ? runTransient() : runSimulation())}
          disabled={running || computing}
        >
          {computing ? `◌ ${t('tb.computing')}` : running ? `◌ ${t('tb.solving')}` : transient ? `▶ ${t('tb.runTransient')}` : `▶ ${t('tb.run')}`}
        </button>
        <select
          className="select"
          value={simMode}
          aria-label={t('mode.label')}
          onChange={(e) => dispatch(setSimMode(e.target.value as SimMode))}
          title={`${t('mode.label')} — ${t(`modeHelp.${simMode}`)}`}
        >
          <option value="steady-live" title={t('modeHelp.steady-live')}>{t('mode.steady-live')}</option>
          <option value="steady-manual" title={t('modeHelp.steady-manual')}>{t('mode.steady-manual')}</option>
          <option value="transient" title={t('modeHelp.transient')}>{t('mode.transient')}</option>
        </select>
        <span className="mode-help" title={t(`modeHelp.${simMode}`)}>{t(`modeHelp.${simMode}`)}</span>
        <div className="tsep" />
        <button
          className={`tbtn${showLabels ? ' active' : ''}`}
          title={t('tb.labels')}
          aria-label={t('tb.labels')}
          aria-pressed={showLabels}
          onClick={() => dispatch(toggleLabels())}
        >
          ⌗
        </button>
        <button
          className="tbtn unit-toggle"
          title={t('tb.unitsTitle', { unit: tempUnit })}
          aria-label={t('tb.unitsTitle', { unit: tempUnit })}
          onClick={() => dispatch(toggleTempUnit())}
        >
          °{tempUnit}
        </button>
        <select
          className="select"
          value={lang}
          aria-label={t('tb.language')}
          title={t('tb.language')}
          onChange={(e) => {
            const next = e.target.value as Lang
            dispatch(setLang(next))
            persistLang(next)
          }}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

const svgNew = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
  </svg>
)
const svgOpen = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2 4h4l1.5 2H14v7H2z" />
  </svg>
)
const svgSave = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M3 2h8l3 3v9H3z" />
    <path d="M5 2v4h5V2M5 14v-4h6v4" />
  </svg>
)
// auto-arrange: one node on the left branching to two on the right (a tidy
// left-to-right graph) — distinct from the document/zoom icons
const svgArrange = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <rect x="1" y="6" width="4.2" height="4" rx="1" />
    <rect x="10.8" y="1.5" width="4.2" height="4" rx="1" />
    <rect x="10.8" y="10.5" width="4.2" height="4" rx="1" />
    <path d="M5.2 8h2.9M8.1 8V3.5h2.7M8.1 8v4.5h2.7" />
  </svg>
)

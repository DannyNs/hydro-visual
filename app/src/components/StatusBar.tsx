import { useAppSelector } from '../store/hooks'
import { useT } from '../i18n/useT'
import type { SolveResult } from '../solver/contract'

// Turn a raw solve status into a human-readable explanation for the status bar.
function solverMessage(result: SolveResult, nodeCount: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  switch (result.status) {
    case 'empty':
      return nodeCount === 0
        ? t('solver.emptyNoNodes')
        : t('solver.emptyNoLoop')
    case 'error':
      return result.message
        ? t('solver.error', { msg: result.message })
        : t('solver.errorGeneric')
    case 'diverged':
      return result.message
        ? t('solver.diverged', { msg: result.message })
        : t('solver.divergedGeneric')
    default:
      return `Solver: ${result.status}`
  }
}

// Simulated elapsed time as a clock (H:MM:SS past an hour, else M:SS).
function fmtClock(s: number): string {
  const sec = Math.max(0, Math.floor(s))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export default function StatusBar() {
  const { t } = useT()
  const { projectName, units, simMode } = useAppSelector((s) => s.ui)
  const result = useAppSelector((s) => s.sim.result)
  const running = useAppSelector((s) => s.sim.running)
  const nodeCount = useAppSelector((s) => s.graph.nodes.length)
  const simT = useAppSelector((s) => s.playback.simT)
  const hasFrames = useAppSelector((s) => s.playback.frames.length > 1)
  const showClock = simMode === 'transient' && hasFrames

  const converged = result.status === 'converged'
  const problem = result.status === 'empty' || result.status === 'error' || result.status === 'diverged'
  const statusText = running
    ? `◌ ${t('status.solving')}`
    : converged
      ? `✔ ${t('status.converged')}`
      : solverMessage(result, nodeCount, t)
  return (
    <div className="status">
      <span>{t('status.project')}: {projectName}</span>
      <span className="dot">·</span>
      <span>{t('status.units')}: {units}</span>
      <span className="dot">·</span>
      <span>{t('mode.' + simMode)}</span>
      <span className="dot">·</span>
      <span>{t('status.components', { n: nodeCount })}</span>
      {showClock && (
        <>
          <span className="dot">·</span>
          <span className="ok" title={t('status.simTimeHint')}>
            ⏱ {t('status.simTime')}: {fmtClock(simT)}
          </span>
        </>
      )}
      <div className="sp">
        <span
          className={converged ? 'ok' : problem && !running ? 'warn' : ''}
          title={problem && !running ? statusText : undefined}
        >
          {statusText}
        </span>
        <span>{t('status.iterations')}: {result.iterations}</span>
        <span>{t('status.elapsed')}: {result.elapsedMs > 0 ? `${result.elapsedMs.toFixed(2)} ms` : '—'}</span>
      </div>
    </div>
  )
}

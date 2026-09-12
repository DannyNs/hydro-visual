import { useAppDispatch, useAppSelector } from '../store/hooks'
import { setSimT, play, pause, setSpeed, resetPlayback } from '../store/playbackSlice'
import { applyFrame } from '../store/run'
import { useT } from '../i18n/useT'

// Simulated-time speed multipliers (× real time). 1× = real time; 60× plays one
// simulated minute per real second; 1800× collapses a 2-hour charge into ~6 s.
const SPEEDS = [1, 10, 60, 300, 1800]

// Simulated elapsed time as a clock. Shows H:MM:SS once past an hour, else M:SS.
function fmtClock(s: number): string {
  const sec = Math.max(0, Math.floor(s))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export default function TransportBar() {
  const dispatch = useAppDispatch()
  const { t } = useT()
  const frames = useAppSelector((s) => s.playback.frames)
  const idx = useAppSelector((s) => s.playback.idx)
  const simT = useAppSelector((s) => s.playback.simT)
  const endT = useAppSelector((s) => s.playback.endT)
  const playing = useAppSelector((s) => s.playback.playing)
  const speed = useAppSelector((s) => s.playback.speed)

  if (frames.length < 2) return null
  const supply = frames[idx]?.global.supplyC ?? 0

  const scrub = (simSeconds: number) => {
    dispatch(setSimT(simSeconds))
    dispatch(applyFrame())
  }
  const onPlay = () => {
    if (playing) {
      dispatch(pause())
      return
    }
    if (simT >= endT) scrub(0)
    dispatch(play())
  }

  return (
    <div className="transport">
      <button className="t-play" onClick={onPlay} title={playing ? t('transport.pause') : t('transport.play')}>
        {playing ? '⏸' : '▶'}
      </button>
      <button
        className="t-btn"
        title={t('transport.restart')}
        onClick={() => {
          dispatch(resetPlayback())
          dispatch(applyFrame(0))
        }}
      >
        ⟲
      </button>
      <input
        className="t-scrub"
        type="range"
        min={0}
        max={Math.max(1, Math.round(endT))}
        value={Math.round(simT)}
        onChange={(e) => scrub(Number(e.target.value))}
      />
      <span className="t-time num" title={t('transport.elapsed')}>
        <span className="t-clock">{fmtClock(simT)}</span>
        <span className="t-dim"> / {fmtClock(endT)}</span>
      </span>
      <span className="t-temp num" title={t('transport.supplyTemp')}>
        {supply.toFixed(1)} °C
      </span>
      <select
        className="t-speed"
        value={speed}
        onChange={(e) => dispatch(setSpeed(Number(e.target.value)))}
        title={t('transport.speedHint')}
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s === 1 ? t('transport.realtime') : `${s}×`}
          </option>
        ))}
      </select>
    </div>
  )
}

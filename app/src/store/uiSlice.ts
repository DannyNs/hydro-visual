import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { detectLang, type Lang } from '../i18n'

export type SimMode = 'steady-live' | 'steady-manual' | 'transient'
export type TempUnit = 'C' | 'F'

interface UiState {
  projectName: string
  units: 'SI'
  /** preferred temperature display unit (UI-only; physics always runs in °C) */
  tempUnit: TempUnit
  simMode: SimMode
  showLabels: boolean
  bottomTab: 'overview' | 'charts' | 'table' | 'energy' | 'pumps'
  lang: Lang
  /** last auto-arrange: `seq` bumps on every click (drives a transient toast),
   *  `variant` is which layout preset was applied */
  arrange: { seq: number; variant: number }
}

const initialState: UiState = {
  projectName: 'Example House',
  units: 'SI',
  tempUnit: 'C',
  simMode: 'steady-live',
  showLabels: true,
  bottomTab: 'charts',
  lang: detectLang(),
  arrange: { seq: 0, variant: 0 },
}

export const SIM_MODE_LABEL: Record<SimMode, string> = {
  'steady-live': 'Steady · Live',
  'steady-manual': 'Steady · Manual',
  transient: 'Real-time · Charge-up',
}

// One-line plain-language explanation of each simulation mode, surfaced as
// tooltips / helper text so the jargon labels are understandable.
export const SIM_MODE_HELP: Record<SimMode, string> = {
  'steady-live': 'Instant steady state (no time), re-solved on every edit.',
  'steady-manual': 'Steady state, but only solves when you press Run.',
  transient: 'Watch the system heat up from cold in real time, with an elapsed clock and speed control.',
}

// ---- temperature unit helpers (UI display only) ----

export function convertTemp(celsius: number, unit: TempUnit): number {
  return unit === 'F' ? celsius * 1.8 + 32 : celsius
}

/** Format a Celsius value for display in the user's chosen unit, e.g. "50.1 °C". */
export function formatTemp(celsius: number, unit: TempUnit, digits = 1): string {
  if (!isFinite(celsius)) return '—'
  return `${convertTemp(celsius, unit).toFixed(digits)} °${unit}`
}

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setBottomTab(state, action: PayloadAction<UiState['bottomTab']>) {
      state.bottomTab = action.payload
    },
    setSimMode(state, action: PayloadAction<SimMode>) {
      state.simMode = action.payload
    },
    toggleLabels(state) {
      state.showLabels = !state.showLabels
    },
    setProjectName(state, action: PayloadAction<string>) {
      state.projectName = action.payload
    },
    setTempUnit(state, action: PayloadAction<TempUnit>) {
      state.tempUnit = action.payload
    },
    toggleTempUnit(state) {
      state.tempUnit = state.tempUnit === 'C' ? 'F' : 'C'
    },
    setLang(state, action: PayloadAction<Lang>) {
      state.lang = action.payload
    },
    bumpArrange(state, action: PayloadAction<number>) {
      state.arrange = { seq: state.arrange.seq + 1, variant: action.payload }
    },
  },
})

export const {
  setBottomTab,
  setSimMode,
  toggleLabels,
  setProjectName,
  setTempUnit,
  toggleTempUnit,
  setLang,
  bumpArrange,
} = uiSlice.actions
export default uiSlice.reducer

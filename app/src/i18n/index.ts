import { CATALOG, CATEGORIES } from '../model/catalog'
import type { ComponentKind } from '../model/types'
import { en } from './en'
import { pl } from './pl'
import { de } from './de'
import { fr } from './fr'
import { es } from './es'

export type Lang = 'en' | 'pl' | 'de' | 'fr' | 'es'
export type Dict = Record<string, string>

export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'pl', name: 'Polski' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
]

const DICTS: Record<Lang, Dict> = { en, pl, de, fr, es }

/** Translate a chrome key, falling back to English then the raw key. Supports
 *  `{var}` interpolation. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]))
  return s
}

/** Localised component label — falls back to the catalog's English label. */
export function compLabel(kind: ComponentKind, lang: Lang): string {
  const fallback = CATALOG[kind]?.label ?? kind
  if (lang === 'en') return fallback
  return DICTS[lang]?.[`comp.${kind}`] ?? fallback
}

/** Localised palette-category label. */
export function catLabel(id: string, lang: Lang): string {
  const fallback = CATEGORIES.find((c) => c.id === id)?.label ?? id
  if (lang === 'en') return fallback
  return DICTS[lang]?.[`cat.${id}`] ?? fallback
}

/** Localised parameter label, keyed by the English label (params reuse keys
 *  like `ratedKw` for different meanings, so key on the displayed text). */
export function paramLabel(englishLabel: string, lang: Lang): string {
  if (lang === 'en') return englishLabel
  return DICTS[lang]?.[`param.${englishLabel}`] ?? englishLabel
}

/** Localised component tooltip: "Label — one-line description". Both halves fall
 *  back to English (`comp.*` / `desc.*` keys) when a language lacks them. */
export function descLabel(kind: ComponentKind, lang: Lang): string {
  return `${compLabel(kind, lang)} — ${translate(lang, `desc.${kind}`)}`
}

const LS_KEY = 'hydro-visual:lang'

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_KEY) as Lang | null
    if (saved && LANGS.some((l) => l.code === saved)) return saved
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase()
  return (LANGS.find((l) => l.code === nav)?.code as Lang) ?? 'en'
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LS_KEY, lang)
  } catch {
    /* ignore */
  }
}

import { useCallback } from 'react'
import { useAppSelector } from '../store/hooks'
import { translate, compLabel, catLabel, paramLabel, descLabel, type Lang } from './index'
import type { ComponentKind } from '../model/types'

/** Hook returning a translator bound to the current UI language. */
export function useT() {
  const lang = useAppSelector((s) => s.ui.lang)
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
  return {
    t,
    lang: lang as Lang,
    comp: (kind: ComponentKind) => compLabel(kind, lang),
    cat: (id: string) => catLabel(id, lang),
    param: (englishLabel: string) => paramLabel(englishLabel, lang),
    describe: (kind: ComponentKind) => descLabel(kind, lang),
  }
}

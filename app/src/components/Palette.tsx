import { useMemo, useState } from 'react'
import { CATALOG, CATEGORIES } from '../model/catalog'
import type { ComponentKind } from '../model/types'
import { Glyph } from '../canvas/glyphs'
import { DRAG_KEY } from '../canvas/CanvasEditor'
import { useT } from '../i18n/useT'

export default function Palette() {
  const { t, comp, cat: catLabel, describe } = useT()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CATEGORIES.map((cat) => ({
      ...cat,
      kinds: cat.kinds.filter(
        (k) => !q || comp(k).toLowerCase().includes(q) || CATALOG[k].label.toLowerCase().includes(q) || k.includes(q),
      ),
    })).filter((cat) => cat.kinds.length > 0)
  }, [query, comp])

  const onDragStart = (e: React.DragEvent, kind: ComponentKind) => {
    e.dataTransfer.setData(DRAG_KEY, kind)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="col panel panel-l palette">
      <div className="phead">{t('palette.title')}</div>
      <input
        className="search"
        placeholder={t('palette.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.map((cat) => (
        <div key={cat.id}>
          <div className="cat-head">
            <span>{catLabel(cat.id)}</span>
            <span>{cat.kinds.length}</span>
          </div>
          <div className="pal-grid">
            {cat.kinds.map((kind) => (
              <div
                key={kind}
                className="pal-item"
                draggable
                onDragStart={(e) => onDragStart(e, kind)}
                title={`${describe(kind)}\n\n${t('palette.dragHint')}`}
              >
                <Glyph kind={kind} w={36} h={30} params={{}} />
                <span>{shortLabel(comp(kind))}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function shortLabel(label: string): string {
  return label
    .replace('Air Source ', '')
    .replace('Automatic ', '')
    .replace('Temperature ', '')
    .replace('3-Way ', '')
}

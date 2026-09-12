import { sanitizeGraph, type PersistedGraph } from './persist'

// Export / import a design as a JSON file (topology only — solver results and
// React Flow ui flags are stripped). Lets users share or version their designs.
const DROP = new Set(['result', 'selected', 'dragging', 'resizing'])

export function downloadGraph(graph: PersistedGraph, name = 'hydro-design'): void {
  const json = JSON.stringify(graph, (k, v) => (DROP.has(k) ? undefined : v), 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function pickGraphFile(): Promise<PersistedGraph | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const g = JSON.parse(String(reader.result))
          if (g && Array.isArray(g.nodes) && Array.isArray(g.edges))
            resolve(sanitizeGraph(g as PersistedGraph))
          else resolve(null)
        } catch {
          resolve(null)
        }
      }
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    }
    input.click()
  })
}

// Temperature -> color mapping shared by pipes, nodes, the legend and tank
// stratification. Spans the typical hydronic operating band so the colours are
// well separated there: cold (~20 °C) blue → hot (~60 °C) red, through cyan /
// green / amber. Temperatures outside the band clamp to the ends.

export const TEMP_MIN = 20
export const TEMP_MAX = 60

export function tempT(c: number): number {
  return Math.max(0, Math.min(1, (c - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)))
}

export function tempColor(c: number): string {
  const t = tempT(c)
  // hue 210 (blue) -> 0 (red); lift lightness slightly in the middle
  const hue = 210 - t * 210
  const light = 52 + Math.sin(t * Math.PI) * 6
  return `hsl(${hue.toFixed(0)}, 85%, ${light.toFixed(0)}%)`
}

// CSS gradient string for the legend bar / tank.
export function tempGradient(stops = 6): string {
  const parts: string[] = []
  for (let i = 0; i < stops; i++) {
    const c = TEMP_MIN + (i / (stops - 1)) * (TEMP_MAX - TEMP_MIN)
    parts.push(`${tempColor(c)} ${((i / (stops - 1)) * 100).toFixed(0)}%`)
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

export const LINE_COLORS = {
  hot: '#e5484d',
  cold: '#3b82f6',
  mix: '#a855f7',
  idle: '#3a4658',
}

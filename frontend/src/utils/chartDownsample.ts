/** Keep chart point count bounded so Recharts stays responsive during long runs. */

const DEFAULT_MAX_POINTS = 400

export function downsamplePoints<T extends { t: number }>(
  points: T[],
  maxPoints = DEFAULT_MAX_POINTS
): T[] {
  const sorted = [...points].sort((a, b) => a.t - b.t)
  if (sorted.length <= maxPoints) return sorted
  const step = Math.ceil(sorted.length / maxPoints)
  const result: T[] = []
  for (let i = 0; i < sorted.length; i += step) {
    result.push(sorted[i])
  }
  const last = sorted[sorted.length - 1]
  if (result[result.length - 1]?.t !== last.t) {
    result.push(last)
  }
  return result
}

export function downsampleSeries<T extends { t: number }>(
  series: { label: string; points: T[] }[],
  maxPoints = DEFAULT_MAX_POINTS
): { label: string; points: T[] }[] {
  return series.map((s) => ({
    label: s.label,
    points: downsamplePoints(s.points, maxPoints),
  }))
}

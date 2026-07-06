/** Keep chart point count bounded so Recharts stays responsive during long runs. */

const DEFAULT_MAX_POINTS = 400

export function downsamplePoints<T extends { t: number }>(
  points: T[],
  maxPoints = DEFAULT_MAX_POINTS
): T[] {
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  const result: T[] = []
  for (let i = 0; i < points.length; i += step) {
    result.push(points[i])
  }
  const last = points[points.length - 1]
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

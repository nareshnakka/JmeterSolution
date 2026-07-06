/** Adaptive elapsed-time axis labels: MM:SS → HH:MM:SS → HH:MM. */

export type TimelineFormat = 'MM:SS' | 'HH:MM:SS' | 'HH:MM'

export interface TimelineScale {
  format: TimelineFormat
  axisLabel: string
  formatValue: (seconds: number) => string
  formatWithUnit: (seconds: number) => string
}

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

export function resolveTimelineFormat(maxSeconds: number): TimelineFormat {
  if (maxSeconds < 3600) return 'MM:SS'
  if (maxSeconds < 86400) return 'HH:MM:SS'
  return 'HH:MM'
}

export function formatElapsedTime(seconds: number, maxSeconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const format = resolveTimelineFormat(maxSeconds)

  if (format === 'MM:SS') {
    const minutes = Math.floor(total / 60)
    const secs = total % 60
    return `${pad2(minutes)}:${pad2(secs)}`
  }

  if (format === 'HH:MM:SS') {
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = total % 60
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`
  }

  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${hours}:${pad2(minutes)}`
}

export function timelineScaleForSeconds(maxSeconds: number): TimelineScale {
  const format = resolveTimelineFormat(maxSeconds)
  const axisLabel =
    format === 'MM:SS'
      ? 'Elapsed (MM:SS)'
      : format === 'HH:MM:SS'
        ? 'Elapsed (HH:MM:SS)'
        : 'Elapsed (HH:MM)'

  const formatValue = (seconds: number) => formatElapsedTime(seconds, maxSeconds)
  const formatWithUnit = formatValue

  return { format, axisLabel, formatValue, formatWithUnit }
}

export function maxTimeFromPoints(points: { t: number }[]): number {
  if (!points.length) return 0
  return Math.max(...points.map((p) => p.t))
}

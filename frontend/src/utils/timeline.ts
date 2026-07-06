/** Adaptive timeline scale: seconds → minutes → hours → days as elapsed time grows. */

export type TimelineUnit = 's' | 'min' | 'h' | 'd'

export interface TimelineScale {
  unit: TimelineUnit
  divisor: number
  axisLabel: string
  formatValue: (seconds: number) => string
  formatWithUnit: (seconds: number) => string
}

export function timelineScaleForSeconds(maxSeconds: number): TimelineScale {
  let unit: TimelineUnit
  let divisor: number
  let axisLabel: string

  if (maxSeconds < 120) {
    unit = 's'
    divisor = 1
    axisLabel = 'Seconds'
  } else if (maxSeconds < 3600) {
    unit = 'min'
    divisor = 60
    axisLabel = 'Minutes'
  } else if (maxSeconds < 86400) {
    unit = 'h'
    divisor = 3600
    axisLabel = 'Hours'
  } else {
    unit = 'd'
    divisor = 86400
    axisLabel = 'Days'
  }

  const formatValue = (seconds: number) => {
    const v = seconds / divisor
    if (unit === 's') return String(Math.round(v))
    if (v >= 100) return String(Math.round(v))
    if (v >= 10) return v.toFixed(0)
    return v.toFixed(1)
  }

  const formatWithUnit = (seconds: number) => `${formatValue(seconds)} ${unit}`

  return { unit, divisor, axisLabel, formatValue, formatWithUnit }
}

export function maxTimeFromPoints(points: { t: number }[]): number {
  if (!points.length) return 0
  return Math.max(...points.map((p) => p.t))
}

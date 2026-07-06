/** Server stores UTC; browser displays and edits in local time. */

export function parseUtc(iso?: string | null): Date | null {
  if (!iso) return null
  const normalized =
    iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatLocalDateTime(iso?: string | null, options?: Intl.DateTimeFormatOptions): string {
  const date = parseUtc(iso)
  if (!date) return '—'
  return date.toLocaleString(undefined, options)
}

export function formatLocalTime(iso?: string | null): string {
  const date = parseUtc(iso)
  if (!date) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function toLocalInputValue(iso?: string | null): string {
  const date = parseUtc(iso)
  if (!date) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function defaultLocalDateTimeInput(minutesAhead = 30): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() + minutesAhead)
  d.setSeconds(0, 0)
  return toLocalInputValue(d.toISOString())
}

export function localInputToUtcIso(localValue: string): string {
  return new Date(localValue).toISOString()
}

export function localTimezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'local time'
  }
}

export function isFutureLocalDateTime(localValue: string): boolean {
  const target = new Date(localValue)
  return !Number.isNaN(target.getTime()) && target.getTime() > Date.now()
}

import { useEffect, useState } from 'react'
import { api } from '../api'
import {
  defaultLocalDateTimeInput,
  formatLocalDateTime,
  formatLocalTime,
  isFutureLocalDateTime,
  localInputToUtcIso,
  localTimezoneLabel,
  toLocalInputValue,
} from '../utils/datetime'
import { useToast } from './Toast'
import type { ScenarioListItem, ScenarioSchedule } from '../types'

const WEEKDAYS = [
  { id: 0, label: 'Mon' },
  { id: 1, label: 'Tue' },
  { id: 2, label: 'Wed' },
  { id: 3, label: 'Thu' },
  { id: 4, label: 'Fri' },
  { id: 5, label: 'Sat' },
  { id: 6, label: 'Sun' },
]

type Frequency = 'once' | 'daily' | 'weekly'

interface ScenarioScheduleModalProps {
  scenario: ScenarioListItem
  onClose: () => void
  onSaved: () => void
}

export default function ScenarioScheduleModal({ scenario, onClose, onSaved }: ScenarioScheduleModalProps) {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [existing, setExisting] = useState<ScenarioSchedule | null>(null)
  const [frequency, setFrequency] = useState<Frequency>('once')
  const [runAtLocal, setRunAtLocal] = useState(defaultLocalDateTimeInput())
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([0, 1, 2, 3, 4])
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const timezoneLabel = localTimezoneLabel()

  useEffect(() => {
    api.getScenarioSchedule(scenario.id)
      .then((schedule) => {
        if (schedule) {
          setExisting(schedule)
          setFrequency(schedule.frequency)
          setRunAtLocal(toLocalInputValue(schedule.run_at))
          setDaysOfWeek(schedule.days_of_week.length > 0 ? schedule.days_of_week : [0])
          setNotes(schedule.notes ?? '')
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [scenario.id])

  function toggleDay(dayId: number) {
    setDaysOfWeek((prev) =>
      prev.includes(dayId) ? prev.filter((d) => d !== dayId) : [...prev, dayId].sort()
    )
  }

  async function saveSchedule() {
    if (!runAtLocal) {
      setError('Select a date and time')
      return
    }
    if (frequency === 'weekly' && daysOfWeek.length === 0) {
      setError('Select at least one day for weekly schedule')
      return
    }
    if (frequency === 'once' && !isFutureLocalDateTime(runAtLocal)) {
      setError('Select a date and time in the future')
      return
    }

    setSaving(true)
    setError('')
    try {
      await api.createScenarioSchedule(scenario.id, {
        frequency,
        run_at: localInputToUtcIso(runAtLocal),
        days_of_week: frequency === 'weekly' ? daysOfWeek : undefined,
        notes: notes.trim() || undefined,
      })
      toast.success(`Schedule saved for "${scenario.name}". View it under Run Queue → Scheduled.`)
      onSaved()
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save schedule'
      setError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  async function cancelSchedule() {
    setSaving(true)
    setError('')
    try {
      await api.cancelScenarioSchedule(scenario.id)
      toast.success(`Schedule cancelled for "${scenario.name}"`)
      onSaved()
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to cancel schedule'
      setError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  const timeLabel =
    frequency === 'once'
      ? `Run at (date & time, ${timezoneLabel})`
      : `Run at (time in ${timezoneLabel} — repeats ${frequency === 'daily' ? 'every day' : 'on selected days'})`

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Schedule Test</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="modal-subtitle">
          {scenario.release_name} → {scenario.build_name} → {scenario.application_name}
          <br />
          <strong>{scenario.name}</strong>
        </p>

        {loading ? (
          <p className="modal-current-file">Loading schedule…</p>
        ) : (
          <>
            {existing && (
              <p className="schedule-next-run">
                Current schedule: <strong>{existing.frequency}</strong> — next run{' '}
                <strong>{formatLocalDateTime(existing.next_run_at)}</strong>
              </p>
            )}

            <div className="form-row">
              <label>Frequency</label>
              <div className="schedule-frequency-options">
                {(['once', 'daily', 'weekly'] as Frequency[]).map((f) => (
                  <label key={f} className="schedule-frequency-option">
                    <input
                      type="radio"
                      name="frequency"
                      value={f}
                      checked={frequency === f}
                      onChange={() => setFrequency(f)}
                    />
                    {f === 'once' ? 'Once' : f === 'daily' ? 'Every day' : 'Weekly'}
                  </label>
                ))}
              </div>
            </div>

            {frequency === 'weekly' && (
              <div className="form-row">
                <label>Days</label>
                <div className="schedule-weekdays">
                  {WEEKDAYS.map((d) => (
                    <label key={d.id} className="schedule-weekday">
                      <input
                        type="checkbox"
                        checked={daysOfWeek.includes(d.id)}
                        onChange={() => toggleDay(d.id)}
                      />
                      {d.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="form-row">
              <label>{timeLabel}</label>
              <input
                type="datetime-local"
                value={runAtLocal}
                onChange={(e) => setRunAtLocal(e.target.value)}
              />
            </div>

            <div className="form-row">
              <label>Notes (optional)</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Schedule notes" />
            </div>

            <p className="modal-current-file" style={{ marginTop: '0.75rem' }}>
              Times are entered in your browser&apos;s local timezone ({timezoneLabel}) and converted to server UTC for scheduling.
              Scheduled tests appear under Run Queue → Scheduled.
            </p>

            {error && <p className="modal-error">{error}</p>}

            <div className="modal-actions">
              {existing && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={cancelSchedule}
                  disabled={saving}
                  style={{ marginRight: 'auto' }}
                >
                  Cancel schedule
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Close
              </button>
              <button type="button" className="btn" onClick={saveSchedule} disabled={saving}>
                {saving ? 'Saving…' : existing ? 'Update schedule' : 'Save schedule'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function ScheduleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
      <path d="M12 14v4M10 16h4" />
    </svg>
  )
}

export function formatScheduleFrequency(
  frequency?: string,
  daysOfWeek: number[] = [],
  runAt?: string
): string {
  const time = runAt ? formatLocalTime(runAt) : ''
  if (frequency === 'daily') return time ? `Every day at ${time}` : 'Every day'
  if (frequency === 'weekly') {
    const days = daysOfWeek.map((d) => WEEKDAYS.find((w) => w.id === d)?.label ?? String(d)).join(', ')
    return time ? `Weekly on ${days} at ${time}` : `Weekly on ${days}`
  }
  return 'Once'
}

export function formatNextRun(s: ScenarioListItem): string | null {
  if (!s.next_run_at || !s.schedule_frequency) return null
  const when = formatLocalDateTime(s.next_run_at)
  if (s.schedule_frequency === 'daily') return `Daily · ${when}`
  if (s.schedule_frequency === 'weekly') return `Weekly · ${when}`
  return `Once · ${when}`
}

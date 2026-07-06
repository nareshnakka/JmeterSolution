import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import RunTags from '../components/RunTags'
import ScenarioScheduleModal, { formatScheduleFrequency } from '../components/ScenarioScheduleModal'
import { formatLocalDateTime } from '../utils/datetime'
import { useToast } from '../components/Toast'
import type { QueuedRunItem, ScenarioListItem, ScheduledQueueItem, TestRun, TestRunQueue } from '../types'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function runLabel(run: TestRun) {
  const parts = [run.release_name, run.build_name, run.application_name, run.scenario_name].filter(Boolean)
  return parts.join(' → ') || `Scenario #${run.scenario_id}`
}

function scheduledLabel(item: ScheduledQueueItem) {
  const parts = [item.release_name, item.build_name, item.application_name, item.scenario_name].filter(Boolean)
  return parts.join(' → ') || `Scenario #${item.scenario_id}`
}

function toScenarioListItem(item: ScheduledQueueItem): ScenarioListItem {
  return {
    id: item.scenario_id,
    name: item.scenario_name ?? '',
    tags: item.scenario_tags ?? [],
    jmx_filename: '',
    release_id: item.release_id ?? 0,
    release_name: item.release_name ?? '',
    build_id: item.build_id ?? 0,
    build_name: item.build_name ?? '',
    application_id: item.application_id ?? 0,
    application_name: item.application_name ?? '',
    created_at: item.next_run_at,
    is_running: false,
    schedule_id: item.schedule_id,
    schedule_frequency: item.frequency,
    next_run_at: item.next_run_at,
  }
}

export default function QueuePage() {
  const toast = useToast()
  const [queue, setQueue] = useState<TestRunQueue>({ running: null, queued: [], scheduled: [] })
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [editingSchedule, setEditingSchedule] = useState<ScenarioListItem | null>(null)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getTestRunQueue()
      setQueue({
        running: data.running,
        queued: data.queued,
        scheduled: data.scheduled ?? [],
      })
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadQueue()
    const t = setInterval(loadQueue, 4000)
    return () => clearInterval(t)
  }, [loadQueue])

  async function cancelQueued(run: QueuedRunItem) {
    const key = `run-${run.id}`
    setCancellingId(key)
    try {
      await api.cancelTestRun(run.id)
      toast.success(`Removed run #${run.id} from the queue`)
      await loadQueue()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel queued run')
    } finally {
      setCancellingId(null)
    }
  }

  async function cancelScheduled(item: ScheduledQueueItem) {
    const key = item.schedule_id ? `schedule-${item.schedule_id}` : `test-${item.test_run_id}`
    setCancellingId(key)
    try {
      if (item.schedule_id) {
        await api.cancelScenarioSchedule(item.scenario_id)
        toast.success(`Schedule cancelled for "${item.scenario_name ?? 'scenario'}"`)
      } else if (item.test_run_id) {
        await api.cancelTestRun(item.test_run_id)
        toast.success(`Cancelled scheduled run #${item.test_run_id}`)
      }
      await loadQueue()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel schedule')
    } finally {
      setCancellingId(null)
    }
  }

  function cancelKey(item: ScheduledQueueItem) {
    return item.schedule_id ? `schedule-${item.schedule_id}` : `test-${item.test_run_id}`
  }

  const isIdle = !queue.running && queue.queued.length === 0 && queue.scheduled.length === 0

  return (
    <>
      <h1 className="page-title">Run Queue</h1>
      <p className="page-lead">
        Only one test runs at a time. Additional runs wait in the queue until the server is free.
        Scheduled tests appear below and start automatically at the configured time.
      </p>

      <div className="card">
        <div className="table-toolbar">
          <span className="table-toolbar-count">
            {loading && isIdle ? 'Loading…' : queue.running ? '1 running' : 'Idle'}
            {queue.queued.length > 0 && ` · ${queue.queued.length} queued`}
            {queue.scheduled.length > 0 && ` · ${queue.scheduled.length} scheduled`}
          </span>
          <button className="btn btn-secondary" onClick={loadQueue} disabled={loading}>
            Refresh
          </button>
        </div>

        <h2 className="queue-section-title">Currently running</h2>
        {queue.running ? (
          <div className="queue-running-card">
            <div>
              <strong>#{queue.running.id}</strong> — {runLabel(queue.running)}
              <div style={{ marginTop: '0.35rem' }}>
                {statusBadge(queue.running.status)}
                {queue.running.started_at && (
                  <span className="queue-meta">
                    Started {new Date(queue.running.started_at).toLocaleString()}
                  </span>
                )}
              </div>
              {queue.running.scenario_tags && queue.running.scenario_tags.length > 0 && (
                <div style={{ marginTop: '0.35rem' }}>
                  <RunTags tags={queue.running.scenario_tags} />
                </div>
              )}
            </div>
            <Link to={`/live/${queue.running.id}`} className="btn">
              Open live dashboard
            </Link>
          </div>
        ) : (
          <p className="empty">No test is running</p>
        )}

        <h2 className="queue-section-title">Waiting in queue</h2>
        {queue.queued.length === 0 ? (
          <p className="empty">Queue is empty</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Run</th>
                  <th>Scenario</th>
                  <th>Type</th>
                  <th>Queued at</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.queued.map((run) => (
                  <tr key={run.id}>
                    <td>{run.queue_position}</td>
                    <td>#{run.id}</td>
                    <td>
                      <div>{runLabel(run)}</div>
                      {run.scenario_tags && run.scenario_tags.length > 0 && (
                        <RunTags tags={run.scenario_tags} />
                      )}
                    </td>
                    <td>{run.run_type}</td>
                    <td>{new Date(run.created_at).toLocaleString()}</td>
                    <td>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        disabled={cancellingId === `run-${run.id}`}
                        onClick={() => cancelQueued(run)}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 className="queue-section-title">Scheduled</h2>
        {queue.scheduled.length === 0 ? (
          <p className="empty">No scheduled tests</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Frequency</th>
                  <th>Next run (local)</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.scheduled.map((item) => (
                  <tr key={item.schedule_id ? `s-${item.schedule_id}` : `t-${item.test_run_id}`}>
                    <td>
                      <div>{scheduledLabel(item)}</div>
                      {item.scenario_tags && item.scenario_tags.length > 0 && (
                        <RunTags tags={item.scenario_tags} />
                      )}
                      {item.test_run_id && (
                        <div className="queue-meta">Scheduled run #{item.test_run_id}</div>
                      )}
                    </td>
                    <td>
                      {formatScheduleFrequency(item.frequency, item.days_of_week, item.run_at)}
                    </td>
                    <td>{formatLocalDateTime(item.next_run_at)}</td>
                    <td>{item.notes?.trim() || '—'}</td>
                    <td>
                      <div className="queue-action-buttons">
                        {item.schedule_id && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            onClick={() => setEditingSchedule(toScenarioListItem(item))}
                          >
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          disabled={cancellingId === cancelKey(item)}
                          onClick={() => cancelScheduled(item)}
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingSchedule && (
        <ScenarioScheduleModal
          scenario={editingSchedule}
          onClose={() => setEditingSchedule(null)}
          onSaved={() => {
            setEditingSchedule(null)
            void loadQueue()
          }}
        />
      )}
    </>
  )
}

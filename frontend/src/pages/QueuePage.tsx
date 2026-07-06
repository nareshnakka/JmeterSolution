import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import RunTags from '../components/RunTags'
import { useToast } from '../components/Toast'
import type { QueuedRunItem, TestRun, TestRunQueue } from '../types'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function runLabel(run: TestRun) {
  const parts = [run.release_name, run.build_name, run.application_name, run.scenario_name].filter(Boolean)
  return parts.join(' → ') || `Scenario #${run.scenario_id}`
}

export default function QueuePage() {
  const toast = useToast()
  const [queue, setQueue] = useState<TestRunQueue>({ running: null, queued: [] })
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState<number | null>(null)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getTestRunQueue()
      setQueue(data)
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
    setCancellingId(run.id)
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

  const isIdle = !queue.running && queue.queued.length === 0

  return (
    <>
      <h1 className="page-title">Run Queue</h1>
      <p className="page-lead">
        Only one test runs at a time. Additional runs wait here until the server is free.
      </p>

      <div className="card">
        <div className="table-toolbar">
          <span className="table-toolbar-count">
            {loading && isIdle ? 'Loading…' : queue.running ? '1 running' : 'Idle'}
            {queue.queued.length > 0 && ` · ${queue.queued.length} queued`}
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
                        disabled={cancellingId === run.id}
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
      </div>
    </>
  )
}

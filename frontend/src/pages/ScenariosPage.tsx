import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import ScenarioEditModal from '../components/ScenarioEditModal'
import { useToast } from '../components/Toast'
import type { ScenarioListItem } from '../types'

const RUN_STATUSES = [
  { value: '', label: 'Any' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'pending', label: 'Pending' },
]

function statusBadge(status?: string | null) {
  if (!status) return <span className="badge">—</span>
  return <span className={`badge badge-${status}`}>{status}</span>
}

export default function ScenariosPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [actionId, setActionId] = useState<number | null>(null)

  const [release, setRelease] = useState('')
  const [build, setBuild] = useState('')
  const [application, setApplication] = useState('')
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [runFrom, setRunFrom] = useState('')
  const [runTo, setRunTo] = useState('')
  const [lastRunStatus, setLastRunStatus] = useState('')
  const [editingScenario, setEditingScenario] = useState<ScenarioListItem | null>(null)

  const hasActiveFilters = Boolean(
    release || build || application || name || tag || runFrom || runTo || lastRunStatus
  )

  const loadScenarios = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listAllScenarios({
        release: release || undefined,
        build: build || undefined,
        application: application || undefined,
        name: name || undefined,
        tag: tag || undefined,
        run_from: runFrom ? new Date(runFrom).toISOString() : undefined,
        run_to: runTo ? new Date(runTo).toISOString() : undefined,
        last_run_status: lastRunStatus || undefined,
      })
      setScenarios(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [release, build, application, name, tag, runFrom, runTo, lastRunStatus])

  useEffect(() => {
    loadScenarios()
    const t = setInterval(loadScenarios, 8000)
    return () => clearInterval(t)
  }, [loadScenarios])

  async function runScenario(scenarioId: number, scenarioName: string) {
    setActionId(scenarioId)
    try {
      toast.info(`Starting test for "${scenarioName}"…`)
      const run = await api.startTest(scenarioId)
      toast.success(`Test started (run #${run.id})`)
      navigate(`/live/${run.id}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start test'
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  async function stopScenario(scenarioId: number, scenarioName: string) {
    setActionId(scenarioId)
    try {
      await api.stopScenario(scenarioId)
      toast.success(`Test stopped for "${scenarioName}"`)
      await loadScenarios()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to stop test'
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  function clearFilters() {
    setRelease('')
    setBuild('')
    setApplication('')
    setName('')
    setTag('')
    setRunFrom('')
    setRunTo('')
    setLastRunStatus('')
  }

  return (
    <>
      <h1 className="page-title">All Scenarios</h1>

      <div className="card">
        <div className="table-toolbar">
          <span className="table-toolbar-count">
            {loading ? 'Loading…' : `${scenarios.length} scenario(s)`}
          </span>
          <button className="btn btn-secondary" onClick={loadScenarios} disabled={loading}>
            Refresh
          </button>
        </div>
        <div className="table-scroll">
          <table className="table-with-filters">
            <thead>
              <tr>
                <th>Release</th>
                <th>Build</th>
                <th>Application</th>
                <th>Scenario</th>
                <th>Tags</th>
                <th>JMX</th>
                <th>Last run</th>
                <th>Run started</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
              <tr className="table-filter-row">
                <th>
                  <input
                    className="table-filter-input"
                    placeholder="Filter…"
                    value={release}
                    onChange={(e) => setRelease(e.target.value)}
                  />
                </th>
                <th>
                  <input
                    className="table-filter-input"
                    placeholder="Filter…"
                    value={build}
                    onChange={(e) => setBuild(e.target.value)}
                  />
                </th>
                <th>
                  <input
                    className="table-filter-input"
                    placeholder="Filter…"
                    value={application}
                    onChange={(e) => setApplication(e.target.value)}
                  />
                </th>
                <th>
                  <input
                    className="table-filter-input"
                    placeholder="Filter…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </th>
                <th>
                  <input
                    className="table-filter-input"
                    placeholder="Filter…"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                  />
                </th>
                <th />
                <th />
                <th>
                  <div className="table-filter-stack">
                    <input
                      className="table-filter-input"
                      type="datetime-local"
                      title="Run date from"
                      value={runFrom}
                      onChange={(e) => setRunFrom(e.target.value)}
                    />
                    <input
                      className="table-filter-input"
                      type="datetime-local"
                      title="Run date to"
                      value={runTo}
                      onChange={(e) => setRunTo(e.target.value)}
                    />
                  </div>
                </th>
                <th>
                  <select
                    className="table-filter-input"
                    value={lastRunStatus}
                    onChange={(e) => setLastRunStatus(e.target.value)}
                  >
                    {RUN_STATUSES.map((s) => (
                      <option key={s.value || 'any'} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </th>
                <th>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      className="btn btn-secondary table-filter-clear"
                      onClick={clearFilters}
                    >
                      Clear
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id}>
                  <td>{s.release_name}</td>
                  <td>{s.build_name}</td>
                  <td>{s.application_name}</td>
                  <td>{s.name}</td>
                  <td>
                    {s.tags.length > 0 ? (
                      <span className="tag-list">
                        {s.tags.map((t) => (
                          <span key={t} className="tag-chip tag-chip-readonly">{t}</span>
                        ))}
                      </span>
                    ) : '—'}
                  </td>
                  <td>{s.jmx_filename}</td>
                  <td>
                    {s.last_run_id ? (
                      <Link to={`/live/${s.last_run_id}`}>#{s.last_run_id}</Link>
                    ) : '—'}
                  </td>
                  <td>
                    {s.last_run_started_at
                      ? new Date(s.last_run_started_at).toLocaleString()
                      : '—'}
                  </td>
                  <td>
                    {s.is_running
                      ? statusBadge('running')
                      : statusBadge(s.last_run_status)}
                  </td>
                  <td>
                    <div className="scenario-actions">
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        disabled={s.is_running}
                        title={s.is_running ? 'Stop the test before editing' : 'Edit scenario'}
                        onClick={() => setEditingScenario(s)}
                      >
                        Edit
                      </button>
                      {s.is_running ? (
                        <>
                          <Link
                            to={`/live/${s.active_run_id}`}
                            className="btn"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          >
                            Live
                          </Link>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            disabled={actionId === s.id}
                            onClick={() => stopScenario(s.id, s.name)}
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          disabled={actionId === s.id}
                          onClick={() => runScenario(s.id, s.name)}
                        >
                          Run
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {scenarios.length === 0 && !loading && <p className="empty">No scenarios match your filters</p>}
      </div>

      {editingScenario && (
        <ScenarioEditModal
          scenario={editingScenario}
          onClose={() => setEditingScenario(null)}
          onSaved={loadScenarios}
        />
      )}
    </>
  )
}

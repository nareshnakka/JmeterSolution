import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import ScenarioEditModal from '../components/ScenarioEditModal'
import ScenarioScheduleModal, { formatNextRun, ScheduleIcon } from '../components/ScenarioScheduleModal'
import StartRunModal from '../components/StartRunModal'
import { useToast } from '../components/Toast'
import { ACTIVE_POLL, IDLE_POLL, useActiveRuns } from '../context/ActiveRunsContext'
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
  const { pollMs, refreshActivity } = useActiveRuns()
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
  const [schedulingScenario, setSchedulingScenario] = useState<ScenarioListItem | null>(null)
  const [startTarget, setStartTarget] = useState<ScenarioListItem | null>(null)

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

  const listPollMs = pollMs(ACTIVE_POLL.scenariosMs, IDLE_POLL.scenariosMs)

  useEffect(() => {
    loadScenarios()
    const t = setInterval(loadScenarios, listPollMs)
    return () => clearInterval(t)
  }, [loadScenarios, listPollMs])

  async function runScenario(description: string) {
    if (!startTarget) return
    const scenarioId = startTarget.id
    const scenarioName = startTarget.name
    setActionId(scenarioId)
    try {
      toast.info(`Starting test for "${scenarioName}"…`)
      const run = await api.startTest(scenarioId, description)
      setStartTarget(null)
      void refreshActivity()
      if (run.status === 'failed') {
        toast.error(run.error_message || `Failed to start test (run #${run.id})`)
        await loadScenarios()
      } else if (run.status === 'pending') {
        toast.success(`Test queued (run #${run.id}) — will start when the server is free`)
        await loadScenarios()
      } else {
        toast.success(`Test started (run #${run.id})`)
        navigate(`/live/${run.id}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start test'
      toast.error(msg)
    } finally {
      setActionId(null)
    }
  }

  async function cancelScenarioSchedule(s: ScenarioListItem) {
    setActionId(s.id)
    try {
      await api.cancelScenarioSchedule(s.id)
      toast.success(`Schedule cancelled for "${s.name}"`)
      await loadScenarios()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel schedule')
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

  async function cloneScenarioItem(s: ScenarioListItem) {
    setActionId(s.id)
    try {
      const cloned = await api.cloneScenario(s.id)
      toast.success(`Cloned as "${cloned.name}". You can rename it below.`)
      await loadScenarios()
      setEditingScenario({
        ...s,
        id: cloned.id,
        name: cloned.name,
        jmx_filename: cloned.jmx_filename,
        tags: cloned.tags ?? [],
        jmeter_properties: cloned.jmeter_properties ?? [],
        created_at: cloned.created_at,
        last_run_id: undefined,
        last_run_status: undefined,
        last_run_started_at: undefined,
        last_run_finished_at: undefined,
        active_run_id: undefined,
        is_running: false,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to clone scenario'
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
          <Link to="/queue" className="btn btn-secondary">
            View queue
          </Link>
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
                <th>Next run</th>
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
                <th />
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
                      : s.is_queued
                        ? statusBadge('pending')
                        : statusBadge(s.last_run_status)}
                  </td>
                  <td>
                    {formatNextRun(s) ? (
                      <div className="schedule-cell">
                        <span className="schedule-cell-text" title={formatNextRun(s) ?? undefined}>
                          {formatNextRun(s)}
                        </span>
                        <button
                          type="button"
                          className="btn-icon btn-icon-danger"
                          title="Cancel schedule"
                          disabled={actionId === s.id}
                          onClick={() => cancelScenarioSchedule(s)}
                        >
                          ×
                        </button>
                      </div>
                    ) : s.is_queued ? (
                      <span className="schedule-cell-text">Queued</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <div className="scenario-actions">
                      <button
                        className="btn btn-icon"
                        style={{ padding: '0.25rem 0.45rem', fontSize: '0.75rem' }}
                        disabled={s.is_running || actionId === s.id}
                        title={s.is_running ? 'Stop the test before scheduling' : 'Schedule test'}
                        onClick={() => setSchedulingScenario(s)}
                      >
                        <ScheduleIcon />
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        disabled={actionId === s.id}
                        title="Clone scenario"
                        onClick={() => cloneScenarioItem(s)}
                      >
                        Clone
                      </button>
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
                      ) : s.is_queued ? (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          disabled={actionId === s.id}
                          onClick={() => stopScenario(s.id, s.name)}
                          title="Remove from queue"
                        >
                          Dequeue
                        </button>
                      ) : (
                        <button
                          className="btn"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          disabled={actionId === s.id}
                          onClick={() => setStartTarget(s)}
                        >
                          Run Test
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

      {schedulingScenario && (
        <ScenarioScheduleModal
          scenario={schedulingScenario}
          onClose={() => setSchedulingScenario(null)}
          onSaved={loadScenarios}
        />
      )}

      {editingScenario && (
        <ScenarioEditModal
          scenario={editingScenario}
          onClose={() => setEditingScenario(null)}
          onSaved={loadScenarios}
        />
      )}

      <StartRunModal
        open={Boolean(startTarget)}
        scenarioName={startTarget?.name ?? ''}
        submitting={actionId === startTarget?.id}
        onClose={() => {
          if (actionId == null) setStartTarget(null)
        }}
        onConfirm={runScenario}
      />
    </>
  )
}

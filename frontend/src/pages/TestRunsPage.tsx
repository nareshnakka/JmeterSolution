import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import RunTags from '../components/RunTags'
import TestRunTableFilters from '../components/TestRunTableFilters'
import { useToast } from '../components/Toast'
import type { TestRun } from '../types'
import { isComparableTestRun } from '../types'
import {
  EMPTY_RUN_FILTERS,
  filterTestRuns,
  hasActiveRunFilters,
  type TestRunColumnFilters,
} from '../utils/testRunFilters'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export default function TestRunsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [runs, setRuns] = useState<TestRun[]>([])
  const [loading, setLoading] = useState(true)
  const [columnFilters, setColumnFilters] = useState<TestRunColumnFilters>(EMPTY_RUN_FILTERS)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [updatingRelease, setUpdatingRelease] = useState(false)

  const loadRuns = useCallback((options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true)
    api
      .listTestRuns()
      .then(setRuns)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadRuns()
    const t = setInterval(() => loadRuns({ silent: true }), 5000)
    return () => clearInterval(t)
  }, [loadRuns])

  const filtered = useMemo(() => filterTestRuns(runs, columnFilters), [runs, columnFilters])

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id))

  const comparableSelectedCount = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const run = runs.find((r) => r.id === id)
        return run && isComparableTestRun(run.status)
      }).length,
    [selected, runs]
  )

  const releaseEligibleSelected = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const run = runs.find((r) => r.id === id)
        return run && isComparableTestRun(run.status)
      }),
    [selected, runs]
  )

  const canMarkForRelease = releaseEligibleSelected.some((id) => {
    const run = runs.find((r) => r.id === id)
    return run && !run.consider_for_release
  })

  const canUnmarkForRelease = releaseEligibleSelected.some((id) => {
    const run = runs.find((r) => r.id === id)
    return run?.consider_for_release
  })

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        filtered.forEach((r) => next.delete(r.id))
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        filtered.forEach((r) => next.add(r.id))
        return next
      })
    }
  }

  function promoteToCompare() {
    const ids = Array.from(selected).filter((id) => {
      const run = runs.find((r) => r.id === id)
      return run && isComparableTestRun(run.status)
    })
    if (ids.length === 0) {
      toast.info('Select completed, failed, or stopped runs to compare')
      return
    }
    navigate('/compare', { state: { selectedRunIds: ids } })
  }

  async function updateConsiderForRelease(consider: boolean) {
    const ids = releaseEligibleSelected.filter((id) => {
      const run = runs.find((r) => r.id === id)
      if (!run) return false
      return consider ? !run.consider_for_release : run.consider_for_release
    })
    if (ids.length === 0 || updatingRelease) return

    setUpdatingRelease(true)
    try {
      const result = await api.setConsiderForRelease(ids, consider)
      loadRuns({ silent: true })
      if (result.updated.length > 0) {
        toast.success(
          consider
            ? `Marked ${result.updated.length} run(s) for release consideration`
            : `Removed ${result.updated.length} run(s) from release consideration`
        )
      }
      if (result.failed.length > 0) {
        toast.error(
          `Could not update ${result.failed.length} run(s): ${result.failed.map((f) => `#${f.id}`).join(', ')}`
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update release consideration')
    } finally {
      setUpdatingRelease(false)
    }
  }

  async function deleteSelected() {
    const ids = Array.from(selected)
    if (ids.length === 0 || deleting) return

    const labels = ids
      .map((id) => {
        const run = runs.find((r) => r.id === id)
        return run ? `#${id} (${run.scenario_name ?? 'unknown'})` : `#${id}`
      })
      .join('\n')

    const message =
      ids.length === 1
        ? `Delete test run #${ids[0]}?\n\nThis will permanently remove the run record and all artifacts (JTL, logs).`
        : `Delete ${ids.length} test runs?\n\n${labels}\n\nThis will permanently remove these runs and all their artifacts.`

    if (!window.confirm(message)) return

    setDeleting(true)
    try {
      const result = await api.deleteTestRuns(ids)
      setSelected((prev) => {
        const next = new Set(prev)
        result.deleted.forEach((id) => next.delete(id))
        return next
      })
      loadRuns({ silent: true })
      if (result.deleted.length > 0) {
        toast.success(
          result.deleted.length === 1
            ? `Deleted test run #${result.deleted[0]}`
            : `Deleted ${result.deleted.length} test runs`
        )
      }
      if (result.failed.length > 0) {
        toast.error(
          `Failed to delete ${result.failed.length} run(s): ${result.failed.map((f) => `#${f.id}`).join(', ')}`
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete test runs')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <h1 className="page-title">Test Runs</h1>

      {loading && runs.length === 0 && (
        <div className="dashboard-results-loading" role="status" aria-live="polite">
          <span className="dashboard-results-spinner" aria-hidden="true" />
          <div className="dashboard-results-loading-text">
            <strong>Loading test runs…</strong>
            <span>Fetching the latest run list from the server.</span>
          </div>
        </div>
      )}

      <div className="filters">
        <button
          type="button"
          className="btn"
          disabled={comparableSelectedCount === 0}
          onClick={promoteToCompare}
        >
          Compare Selected ({comparableSelectedCount})
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canMarkForRelease || updatingRelease}
          onClick={() => void updateConsiderForRelease(true)}
          title="Mark completed, failed, or stopped runs for release consideration"
        >
          {updatingRelease ? 'Updating…' : 'Mark for Release'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canUnmarkForRelease || updatingRelease}
          onClick={() => void updateConsiderForRelease(false)}
          title="Remove selected runs from release consideration"
        >
          Unmark for Release
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={selected.size === 0 || deleting}
          onClick={deleteSelected}
        >
          {deleting ? 'Deleting…' : `Delete Selected (${selected.size})`}
        </button>
      </div>
      <div className="card">
        <div className="table-toolbar">
          <span className="table-toolbar-count">
            {loading && runs.length === 0 ? (
              <span className="table-toolbar-loading">
                <span className="dashboard-results-spinner table-toolbar-spinner" aria-hidden="true" />
                Loading run(s)…
              </span>
            ) : (
              `${filtered.length} run(s)`
            )}
          </span>
        </div>
        <div className="table-scroll">
          <table className="table-with-filters">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    title="Select all visible runs"
                    aria-label="Select all visible runs"
                    disabled={loading && runs.length === 0}
                  />
                </th>
                <th>ID</th>
                <th>Release</th>
                <th>Build</th>
                <th>Application</th>
                <th>Scenario</th>
                <th>Tags</th>
                <th>Type</th>
                <th>Status</th>
                <th>For Release</th>
                <th>Scheduled</th>
                <th>Started</th>
                <th>Actions</th>
              </tr>
              <TestRunTableFilters
                filters={columnFilters}
                onChange={setColumnFilters}
                showConsiderForRelease
                showActionsColumn
                onClear={() => setColumnFilters(EMPTY_RUN_FILTERS)}
                hasActiveFilters={hasActiveRunFilters(columnFilters)}
              />
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className={selected.has(r.id) ? 'selected' : ''}
                  onClick={() => toggle(r.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select test run ${r.id}`}
                    />
                  </td>
                  <td>{r.id}</td>
                  <td>{r.release_name}</td>
                  <td>{r.build_name}</td>
                  <td>{r.application_name ?? '—'}</td>
                  <td>{r.scenario_name}</td>
                  <td><RunTags tags={r.scenario_tags} /></td>
                  <td>{r.run_type}</td>
                  <td>{statusBadge(r.status)}</td>
                  <td>
                    {r.consider_for_release ? (
                      <span className="badge badge-release" title="Consider for release">
                        Yes
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : '—'}</td>
                  <td>{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {(r.status === 'running' || isComparableTestRun(r.status)) && (
                      <Link to={`/live/${r.id}`} className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
                        {r.status === 'running' ? 'Live Dashboard' : 'View Results'}
                      </Link>
                    )}
                    {r.jtl_path && (
                      <a href={api.downloadUrl(r.id, 'results.jtl')} className="btn btn-secondary" style={{ marginLeft: '0.25rem', padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
                        JTL
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && runs.length === 0 ? (
          <div className="table-loading-panel" role="status" aria-live="polite">
            <span className="dashboard-results-spinner" aria-hidden="true" />
            <span>Loading test runs…</span>
          </div>
        ) : (
          filtered.length === 0 && <p className="empty">No test runs found</p>
        )}
      </div>
    </>
  )
}

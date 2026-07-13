import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import {
  archiveStateBadge,
  useArchiveOperations,
} from '../context/ArchiveOperationsContext'
import { useToast } from '../components/Toast'
import type { ArchiveRunItem, DeleteByDateResult, SystemConfig } from '../types'
import { localInputToUtcIso, localTimezoneLabel } from '../utils/datetime'

type ArchiveFilter = 'all' | 'active' | 'archived'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export default function ConfigPage() {
  const toast = useToast()
  const {
    archiveAction,
    archiveBusy,
    archiveRuns,
    restoreRuns,
    runAutoArchive,
    getPendingOp,
    completedGeneration,
  } = useArchiveOperations()
  const [config, setConfig] = useState<SystemConfig | null>(null)
  const [form, setForm] = useState({
    jmeter_home: '',
    data_root: '',
    archive_retention_months: 3,
    auto_archive_enabled: true,
    resource_sample_interval_seconds: 10,
    live_dashboard_refresh_interval_seconds: 10,
    aggregate_total_avg_title: 'Total Avg',
    aggregate_total_avg_filter: '',
    aggregate_load_avg_title: 'Load Avg',
    aggregate_load_avg_filter: '_L_',
    aggregate_submit_avg_title: 'Submit Avg',
    aggregate_submit_avg_filter: '_S_',
  })
  const [saving, setSaving] = useState(false)
  const [runs, setRuns] = useState<ArchiveRunItem[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('all')
  const [search, setSearch] = useState('')
  const [deleteFinishedFrom, setDeleteFinishedFrom] = useState('')
  const [deleteFinishedTo, setDeleteFinishedTo] = useState('')
  const [deleteIncludeArchived, setDeleteIncludeArchived] = useState(true)
  const [deletePreview, setDeletePreview] = useState<DeleteByDateResult | null>(null)
  const [deletePreviewing, setDeletePreviewing] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const loadConfig = useCallback(async () => {
    const data = await api.getConfig()
    setConfig(data)
    setForm({
      jmeter_home: data.jmeter_home,
      data_root: data.data_root,
      archive_retention_months: data.archive_retention_months,
      auto_archive_enabled: data.auto_archive_enabled,
      resource_sample_interval_seconds: data.resource_sample_interval_seconds,
      live_dashboard_refresh_interval_seconds: data.live_dashboard_refresh_interval_seconds,
      aggregate_total_avg_title: data.aggregate_total_avg_title ?? 'Total Avg',
      aggregate_total_avg_filter: data.aggregate_total_avg_filter ?? '',
      aggregate_load_avg_title: data.aggregate_load_avg_title ?? 'Load Avg',
      aggregate_load_avg_filter: data.aggregate_load_avg_filter ?? '_L_',
      aggregate_submit_avg_title: data.aggregate_submit_avg_title ?? 'Submit Avg',
      aggregate_submit_avg_filter: data.aggregate_submit_avg_filter ?? '_S_',
    })
  }, [])

  const loadRuns = useCallback(async () => {
    const archivedOnly = archiveFilter === 'archived'
    const includeArchived = archiveFilter !== 'active'
    const data = await api.listArchiveRuns(archivedOnly, includeArchived)
    setRuns(data)
    setSelected(new Set())
  }, [archiveFilter])

  useEffect(() => {
    loadConfig().catch(console.error)
  }, [loadConfig])

  useEffect(() => {
    loadRuns().catch(console.error)
  }, [loadRuns, completedGeneration])

  const filteredRuns = useMemo(() => {
    if (!search.trim()) return runs
    const q = search.trim().toLowerCase()
    return runs.filter(
      (r) =>
        String(r.id).includes(q) ||
        (r.scenario_name ?? '').toLowerCase().includes(q) ||
        (r.release_name ?? '').toLowerCase().includes(q) ||
        (r.build_name ?? '').toLowerCase().includes(q) ||
        (r.application_name ?? '').toLowerCase().includes(q)
    )
  }, [runs, search])

  const selectedArchived = useMemo(
    () => Array.from(selected).filter((id) => runs.find((r) => r.id === id)?.is_archived),
    [selected, runs]
  )
  const selectedActive = useMemo(
    () => Array.from(selected).filter((id) => !runs.find((r) => r.id === id)?.is_archived),
    [selected, runs]
  )

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await api.saveConfig(form)
      setConfig(updated)
      toast.success('Configuration saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function archiveSelected() {
    if (selectedActive.length === 0) return
    if (!window.confirm(`Archive ${selectedActive.length} selected run(s)?`)) return
    await archiveRuns([...selectedActive])
  }

  async function restoreSelected() {
    if (selectedArchived.length === 0) return
    if (!window.confirm(`Restore ${selectedArchived.length} selected run(s)?`)) return
    await restoreRuns([...selectedArchived])
  }

  async function handleAutoArchive() {
    if (!window.confirm('Run auto-archive now for runs older than the retention period?')) return
    await runAutoArchive()
  }

  function buildDeleteByDateBody(dryRun: boolean) {
    return {
      finished_from: deleteFinishedFrom ? localInputToUtcIso(deleteFinishedFrom) : null,
      finished_to: deleteFinishedTo ? localInputToUtcIso(deleteFinishedTo) : null,
      include_archived: deleteIncludeArchived,
      dry_run: dryRun,
    }
  }

  async function previewDeleteRange() {
    if (!deleteFinishedFrom && !deleteFinishedTo) {
      toast.error('Select at least a Finished From or Finished To date')
      return
    }
    setDeletePreviewing(true)
    try {
      const result = await api.deleteTestRunsByDate(buildDeleteByDateBody(true))
      setDeletePreview(result)
      if (result.match_count === 0) {
        toast.success('No test runs match the selected date range')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to preview delete range')
    } finally {
      setDeletePreviewing(false)
    }
  }

  async function deleteInRange() {
    if (!deleteFinishedFrom && !deleteFinishedTo) {
      toast.error('Select at least a Finished From or Finished To date')
      return
    }
    setDeleteBusy(true)
    try {
      const preview =
        deletePreview ??
        (await api.deleteTestRunsByDate(buildDeleteByDateBody(true)))
      setDeletePreview(preview)
      if (preview.match_count === 0) {
        toast.success('No test runs match the selected date range')
        return
      }
      const rangeLabel = [
        deleteFinishedFrom ? `from ${new Date(deleteFinishedFrom).toLocaleString()}` : null,
        deleteFinishedTo ? `to ${new Date(deleteFinishedTo).toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join(' ')
      if (
        !window.confirm(
          `Permanently delete ${preview.match_count} test run(s) finished ${rangeLabel}?\n\nThis removes run records and all artifacts (JTL, logs, archives). Running, pending, and scheduled runs are never included.`
        )
      ) {
        return
      }
      const result = await api.deleteTestRunsByDate(buildDeleteByDateBody(false))
      setDeletePreview(result)
      setSelected(new Set())
      await loadRuns()
      if (result.deleted.length > 0) {
        toast.success(`Deleted ${result.deleted.length} test run(s)`)
      }
      if (result.failed.length > 0) {
        toast.error(
          `Failed to delete ${result.failed.length} run(s): ${result.failed.map((f) => `#${f.id}`).join(', ')}`
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete test runs')
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <>
      <h1 className="page-title">Configuration</h1>

      <div className="card">
        <h2>Server Settings</h2>
        <form className="config-form" onSubmit={saveConfig}>
          <div className="form-row">
            <label htmlFor="jmeter_home">JMeter Home Path</label>
            <input
              id="jmeter_home"
              value={form.jmeter_home}
              onChange={(e) => setForm({ ...form, jmeter_home: e.target.value })}
              placeholder="D:\Jmeter\apache-jmeter-5.5"
              required
            />
            {config && (
              <span className={`config-hint ${config.jmeter_found ? 'config-ok' : 'config-warn'}`}>
                {config.jmeter_found ? 'jmeter.bat found' : 'jmeter.bat not found at this path'}
              </span>
            )}
          </div>
          <div className="form-row">
            <label htmlFor="data_root">Results / Data Directory</label>
            <input
              id="data_root"
              value={form.data_root}
              onChange={(e) => setForm({ ...form, data_root: e.target.value })}
              placeholder="D:\JmeterAgent-Server\data"
              required
            />
          </div>
          <div className="config-form-grid">
            <div className="form-row">
              <label htmlFor="archive_months">Auto-Archive After (months)</label>
              <input
                id="archive_months"
                type="number"
                min={1}
                max={120}
                value={form.archive_retention_months}
                onChange={(e) =>
                  setForm({ ...form, archive_retention_months: Number(e.target.value) || 3 })
                }
              />
              <span className="config-hint">Default: 3 months. Runs older than this are archived automatically.</span>
            </div>
            <div className="form-row config-checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={form.auto_archive_enabled}
                  onChange={(e) => setForm({ ...form, auto_archive_enabled: e.target.checked })}
                />
                Enable automatic archiving (daily at 2:00 AM)
              </label>
            </div>
            <div className="form-row">
              <label htmlFor="resource_interval">Host CPU/Memory Sample Interval (seconds)</label>
              <input
                id="resource_interval"
                type="number"
                min={5}
                max={300}
                value={form.resource_sample_interval_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    resource_sample_interval_seconds: Number(e.target.value) || 10,
                  })
                }
              />
              <span className="config-hint">
                Default: 10 seconds. Applies to new test runs (5–300 seconds).
              </span>
            </div>
            <div className="form-row">
              <label htmlFor="dashboard_refresh_interval">
                Graphs Refresh Interval for Live Dashboard (seconds)
              </label>
              <input
                id="dashboard_refresh_interval"
                type="number"
                min={5}
                max={300}
                value={form.live_dashboard_refresh_interval_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    live_dashboard_refresh_interval_seconds: Number(e.target.value) || 10,
                  })
                }
              />
              <span className="config-hint">
                Default: 10 seconds. How often metrics and graphs refresh on the Live Dashboard (5–300 seconds).
              </span>
            </div>
          </div>
          <div className="config-form-section">
            <h3>Aggregate Report Summary</h3>
            <p className="config-section-hint">
              Shown on the Live Dashboard aggregate report before Export CSV. Each value is the
              average of the Avg (ms) column for matching transaction rows only (APIs/requests are
              excluded). Label filters match substrings (case-insensitive). Leave a filter empty to
              include all transactions.
            </p>
            <div className="config-form-grid">
              <div className="form-row">
                <label htmlFor="aggregate_total_avg_title">Total Avg Title</label>
                <input
                  id="aggregate_total_avg_title"
                  value={form.aggregate_total_avg_title}
                  onChange={(e) => setForm({ ...form, aggregate_total_avg_title: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="aggregate_total_avg_filter">Total Avg Label Filter</label>
                <input
                  id="aggregate_total_avg_filter"
                  value={form.aggregate_total_avg_filter}
                  onChange={(e) => setForm({ ...form, aggregate_total_avg_filter: e.target.value })}
                  placeholder="Empty = all transactions"
                />
              </div>
              <div className="form-row">
                <label htmlFor="aggregate_load_avg_title">Load Avg Title</label>
                <input
                  id="aggregate_load_avg_title"
                  value={form.aggregate_load_avg_title}
                  onChange={(e) => setForm({ ...form, aggregate_load_avg_title: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="aggregate_load_avg_filter">Load Avg Label Filter</label>
                <input
                  id="aggregate_load_avg_filter"
                  value={form.aggregate_load_avg_filter}
                  onChange={(e) => setForm({ ...form, aggregate_load_avg_filter: e.target.value })}
                  placeholder="_L_"
                />
              </div>
              <div className="form-row">
                <label htmlFor="aggregate_submit_avg_title">Submit Avg Title</label>
                <input
                  id="aggregate_submit_avg_title"
                  value={form.aggregate_submit_avg_title}
                  onChange={(e) => setForm({ ...form, aggregate_submit_avg_title: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="aggregate_submit_avg_filter">Submit Avg Label Filter</label>
                <input
                  id="aggregate_submit_avg_filter"
                  value={form.aggregate_submit_avg_filter}
                  onChange={(e) => setForm({ ...form, aggregate_submit_avg_filter: e.target.value })}
                  placeholder="_S_"
                />
              </div>
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: '0.75rem' }}>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Results Archive</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          Archive zips result folders to <code>data\_archive\runs\{'{run_id}'}.zip</code> to save disk space.
          Restore extracts them back to the original location. You can navigate away while archiving or
          extracting — progress appears in the header and a notification shows when finished.
        </p>
        <div className="toolbar">
          <select
            className="table-filter-input"
            value={archiveFilter}
            onChange={(e) => setArchiveFilter(e.target.value as ArchiveFilter)}
          >
            <option value="all">All runs</option>
            <option value="active">Active (not archived)</option>
            <option value="archived">Archived only</option>
          </select>
          <input
            className="table-filter-input"
            placeholder="Search runs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={archiveBusy || selectedActive.length === 0}
            onClick={archiveSelected}
          >
            {archiveAction === 'archive'
              ? `Archiving (${selectedActive.length})…`
              : `Archive Selected (${selectedActive.length})`}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={archiveBusy || selectedArchived.length === 0}
            onClick={restoreSelected}
          >
            {archiveAction === 'restore'
              ? `Extracting (${selectedArchived.length})…`
              : `Restore Selected (${selectedArchived.length})`}
          </button>
          <button type="button" className="btn" disabled={archiveBusy} onClick={handleAutoArchive}>
            {archiveAction === 'auto' ? 'Archiving…' : 'Run Auto-Archive Now'}
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>ID</th>
                <th>Release</th>
                <th>Build</th>
                <th>Application</th>
                <th>Scenario</th>
                <th>Status</th>
                <th>Finished</th>
                <th>Archive</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((r) => (
                <tr
                  key={r.id}
                  className={selected.has(r.id) ? 'selected' : ''}
                  onClick={() => toggle(r.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <input type="checkbox" checked={selected.has(r.id)} readOnly />
                  </td>
                  <td>{r.id}</td>
                  <td>{r.release_name ?? '—'}</td>
                  <td>{r.build_name ?? '—'}</td>
                  <td>{r.application_name ?? '—'}</td>
                  <td>{r.scenario_name ?? '—'}</td>
                  <td>{statusBadge(r.status)}</td>
                  <td>{r.finished_at ? new Date(r.finished_at).toLocaleString() : '—'}</td>
                  <td>{archiveStateBadge(r, getPendingOp(r.id))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredRuns.length === 0 && <p className="empty">No test runs match the filter</p>}
      </div>

      <div className="card">
        <h2>Delete Old Data</h2>
        <p className="config-section-hint">
          Permanently delete completed, failed, or stopped test runs whose{' '}
          <strong>finished</strong> time falls in the selected range. Running, pending, and scheduled
          runs are excluded. Times use your local timezone ({localTimezoneLabel()}).
        </p>
        <div className="config-form-grid delete-range-grid">
          <div className="form-row">
            <label htmlFor="delete_finished_from">Finished From</label>
            <input
              id="delete_finished_from"
              type="datetime-local"
              value={deleteFinishedFrom}
              onChange={(e) => {
                setDeleteFinishedFrom(e.target.value)
                setDeletePreview(null)
              }}
            />
          </div>
          <div className="form-row">
            <label htmlFor="delete_finished_to">Finished To</label>
            <input
              id="delete_finished_to"
              type="datetime-local"
              value={deleteFinishedTo}
              onChange={(e) => {
                setDeleteFinishedTo(e.target.value)
                setDeletePreview(null)
              }}
            />
          </div>
        </div>
        <div className="form-row config-checkbox-row">
          <label>
            <input
              type="checkbox"
              checked={deleteIncludeArchived}
              onChange={(e) => {
                setDeleteIncludeArchived(e.target.checked)
                setDeletePreview(null)
              }}
            />
            Include archived runs
          </label>
        </div>
        <div className="toolbar" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={deletePreviewing || deleteBusy}
            onClick={previewDeleteRange}
          >
            {deletePreviewing ? 'Previewing…' : 'Preview'}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={deleteBusy || deletePreviewing}
            onClick={deleteInRange}
          >
            {deleteBusy ? 'Deleting…' : 'Delete in Range'}
          </button>
        </div>
        {deletePreview && (
          <p className="delete-range-preview">
            {deletePreview.match_count === 0
              ? 'No matching test runs.'
              : `${deletePreview.match_count} test run(s) match the selected range.`}
            {deletePreview.sample_ids.length > 0 && (
              <>
                {' '}
                Sample IDs: {deletePreview.sample_ids.map((id) => `#${id}`).join(', ')}
                {deletePreview.match_count > deletePreview.sample_ids.length ? '…' : ''}
              </>
            )}
          </p>
        )}
      </div>
    </>
  )
}

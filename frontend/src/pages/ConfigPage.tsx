import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useToast } from '../components/Toast'
import type { ArchiveRunItem, SystemConfig } from '../types'

type ArchiveFilter = 'all' | 'active' | 'archived'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export default function ConfigPage() {
  const toast = useToast()
  const [config, setConfig] = useState<SystemConfig | null>(null)
  const [form, setForm] = useState({
    jmeter_home: '',
    data_root: '',
    archive_retention_months: 3,
    auto_archive_enabled: true,
  })
  const [saving, setSaving] = useState(false)
  const [runs, setRuns] = useState<ArchiveRunItem[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  const loadConfig = useCallback(async () => {
    const data = await api.getConfig()
    setConfig(data)
    setForm({
      jmeter_home: data.jmeter_home,
      data_root: data.data_root,
      archive_retention_months: data.archive_retention_months,
      auto_archive_enabled: data.auto_archive_enabled,
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
  }, [loadRuns])

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
    setBusy(true)
    try {
      const result = await api.archiveRuns(selectedActive)
      if (result.succeeded.length) toast.success(`Archived ${result.succeeded.length} run(s)`)
      if (result.failed.length) toast.error(result.failed.map((f) => `#${f.id}: ${f.error}`).join('; '))
      await loadRuns()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Archive failed')
    } finally {
      setBusy(false)
    }
  }

  async function restoreSelected() {
    if (selectedArchived.length === 0) return
    if (!window.confirm(`Restore ${selectedArchived.length} selected run(s)?`)) return
    setBusy(true)
    try {
      const result = await api.restoreRuns(selectedArchived)
      if (result.succeeded.length) toast.success(`Restored ${result.succeeded.length} run(s)`)
      if (result.failed.length) toast.error(result.failed.map((f) => `#${f.id}: ${f.error}`).join('; '))
      await loadRuns()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  async function runAutoArchive() {
    if (!window.confirm('Run auto-archive now for runs older than the retention period?')) return
    setBusy(true)
    try {
      const result = await api.runAutoArchive()
      if (result.archived.length) {
        toast.success(`Auto-archived ${result.archived.length} run(s) older than ${result.retention_months} month(s)`)
      } else {
        toast.success(`No runs older than ${result.retention_months} month(s) to archive`)
      }
      await loadRuns()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Auto-archive failed')
    } finally {
      setBusy(false)
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
          Archive moves result folders to <code>data\_archive\runs</code>. Archived runs are hidden from Test Runs
          but can be restored here. Compare and dashboard still work on archived runs.
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
            disabled={busy || selectedActive.length === 0}
            onClick={archiveSelected}
          >
            Archive Selected ({selectedActive.length})
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || selectedArchived.length === 0}
            onClick={restoreSelected}
          >
            Restore Selected ({selectedArchived.length})
          </button>
          <button type="button" className="btn" disabled={busy} onClick={runAutoArchive}>
            Run Auto-Archive Now
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
                  <td>
                    {r.is_archived ? (
                      <span className="badge badge-cancelled">Archived</span>
                    ) : (
                      <span className="badge badge-completed">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredRuns.length === 0 && <p className="empty">No test runs match the filter</p>}
      </div>
    </>
  )
}

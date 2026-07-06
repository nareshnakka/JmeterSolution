import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import ErrorDetailModal from '../components/ErrorDetailModal'
import JmeterLogConsole from '../components/JmeterLogConsole'
import HostResourceChart from '../components/HostResourceChart'
import {
  ActiveUsersChart,
  ErrorsOverTimeChart,
  ResponseTimeChart,
} from '../components/live/LiveDashboardCharts'
import { useToast } from '../components/Toast'
import type { ErrorSample, LiveMetrics, TestRun, TransactionMetric } from '../types'
import { timelineScaleForSeconds } from '../utils/timeline'

const DEFAULT_REFRESH_SECONDS = 10

type GraphSeries = { label: string; points: { t: number; avg_ms: number }[] }
type ErrorGraphSeries = { label: string; points: { t: number; errors: number }[] }

export default function LiveDashboard() {
  const { runId } = useParams()
  const id = Number(runId)
  const toast = useToast()
  const [run, setRun] = useState<TestRun | null>(null)
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const lastActiveThreadsRef = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set())
  const [labelFilter, setLabelFilter] = useState('')
  const [graphData, setGraphData] = useState<GraphSeries[]>([])
  const [graphMode, setGraphMode] = useState<'individual' | 'cumulative'>('cumulative')
  const [errorsGraphData, setErrorsGraphData] = useState<ErrorGraphSeries[]>([])
  const [errorsGraphMode, setErrorsGraphMode] = useState<'individual' | 'all'>('all')
  const [errorFilter, setErrorFilter] = useState('')
  const [displayedErrors, setDisplayedErrors] = useState<ErrorSample[]>([])
  const [errorsLoading, setErrorsLoading] = useState(false)
  const [viewingError, setViewingError] = useState<ErrorSample | null>(null)
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_SECONDS)
  const [refreshGeneration, setRefreshGeneration] = useState(0)

  const refreshPollMs = refreshIntervalSeconds * 1000
  const refreshInFlightRef = useRef(false)
  const graphIsActiveRef = useRef(true)
  const errorsGraphIsActiveRef = useRef(false)
  const errorSearchRef = useRef('')
  const skipSearchRefreshRef = useRef(true)

  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        setRefreshIntervalSeconds(
          cfg.live_dashboard_refresh_interval_seconds ?? DEFAULT_REFRESH_SECONDS
        )
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    api.getTestRun(id).then(setRun).catch(console.error)
  }, [id])

  useEffect(() => {
    lastActiveThreadsRef.current = 0
    setMetrics(null)
    setGraphData([])
    setErrorsGraphData([])
    setDisplayedErrors([])
    setSelectedLabels(new Set())
    setGraphMode('cumulative')
    setErrorsGraphMode('all')
    setErrorFilter('')
    setRefreshGeneration(0)
    skipSearchRefreshRef.current = true
  }, [id])

  const applyMetrics = useCallback((m: LiveMetrics) => {
    if (m.active_threads > 0) {
      lastActiveThreadsRef.current = m.active_threads
    }
    setMetrics((prev) => {
      if (
        prev &&
        prev.status === m.status &&
        prev.active_threads === m.active_threads &&
        prev.total_samples === m.total_samples &&
        prev.total_errors === m.total_errors &&
        Math.abs(prev.elapsed_seconds - m.elapsed_seconds) < 0.5 &&
        prev.transactions.length === m.transactions.length
      ) {
        return prev
      }
      return m
    })
  }, [])

  const effectiveErrorSearch = useMemo(
    () => (errorFilter.trim() || labelFilter.trim()),
    [errorFilter, labelFilter]
  )

  useEffect(() => {
    errorSearchRef.current = effectiveErrorSearch
  }, [effectiveErrorSearch])

  const loadGraph = useCallback(async (cumulative: boolean) => {
    const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
    if (!cumulative && labels.length === 0) return
    setGraphMode(cumulative ? 'cumulative' : 'individual')
    try {
      const data = await api.getGraph(id, labels, cumulative)
      setGraphData(data.series)
    } catch {
      /* graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const loadErrorsGraph = useCallback(async (allLabels: boolean) => {
    const labels = allLabels ? ['ALL'] : Array.from(selectedLabels)
    if (!allLabels && labels.length === 0) return
    setErrorsGraphMode(allLabels ? 'all' : 'individual')
    try {
      const data = await api.getErrorsGraph(id, labels)
      setErrorsGraphData(data.series)
    } catch {
      /* error graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const selectedLabelsKey = useMemo(() => Array.from(selectedLabels).sort().join('\0'), [selectedLabels])
  const graphIsActive = graphMode === 'cumulative' || selectedLabels.size > 0
  const errorsGraphIsActive =
    errorsGraphMode === 'all' ||
    selectedLabels.size > 0 ||
    (metrics?.total_errors ?? 0) > 0

  useEffect(() => {
    graphIsActiveRef.current = graphIsActive
  }, [graphIsActive])

  useEffect(() => {
    errorsGraphIsActiveRef.current = errorsGraphIsActive
  }, [errorsGraphIsActive])

  const refreshDashboard = useCallback(async (options?: { showErrorsLoading?: boolean }) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      try {
        const m = await api.getMetrics(id)
        applyMetrics(m)
        if (m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled') {
          setStopping(false)
        }
      } catch {
        /* JTL may not exist yet at test start */
      }

      const secondary: Promise<void>[] = []

      if (options?.showErrorsLoading) {
        setErrorsLoading(true)
      }
      secondary.push(
        api.getRunErrors(id, errorSearchRef.current || undefined)
          .then((data) => setDisplayedErrors(data))
          .catch(() => setDisplayedErrors([]))
          .finally(() => {
            if (options?.showErrorsLoading) setErrorsLoading(false)
          })
      )

      if (graphIsActiveRef.current) {
        const cumulative = graphMode === 'cumulative'
        const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
        if (cumulative || labels.length > 0) {
          secondary.push(
            api.getGraph(id, labels, cumulative)
              .then((data) => setGraphData(data.series))
              .catch(() => {})
          )
        }
      }

      if (errorsGraphIsActiveRef.current) {
        const allLabels = errorsGraphMode === 'all'
        const labels = allLabels ? ['ALL'] : Array.from(selectedLabels)
        if (allLabels || labels.length > 0) {
          secondary.push(
            api.getErrorsGraph(id, labels)
              .then((data) => setErrorsGraphData(data.series))
              .catch(() => {})
          )
        }
      }

      await Promise.all(secondary)
      setRefreshGeneration((g) => g + 1)
    } finally {
      refreshInFlightRef.current = false
    }
  }, [id, applyMetrics, graphMode, errorsGraphMode, selectedLabels])

  useEffect(() => {
    let cancelled = false

    async function tick(showErrorsLoading: boolean) {
      if (cancelled) return
      await refreshDashboard({ showErrorsLoading })
    }

    void tick(true)
    const interval = setInterval(() => void tick(false), refreshPollMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [refreshPollMs, refreshDashboard])

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/test-runs/${id}`)

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'finished') {
        setStopping(false)
        void refreshDashboard()
      }
    }

    return () => ws.close()
  }, [id, refreshDashboard])

  useEffect(() => {
    if (graphMode === 'cumulative') {
      void loadGraph(true)
    } else if (selectedLabels.size > 0) {
      void loadGraph(false)
    } else {
      setGraphData([])
    }
  }, [graphMode, selectedLabelsKey, loadGraph])

  useEffect(() => {
    if (errorsGraphMode === 'all') {
      void loadErrorsGraph(true)
    } else if (selectedLabels.size > 0) {
      void loadErrorsGraph(false)
    } else {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode, selectedLabelsKey, loadErrorsGraph])

  useEffect(() => {
    if (skipSearchRefreshRef.current) {
      skipSearchRefreshRef.current = false
      return
    }
    void refreshDashboard({ showErrorsLoading: true })
  }, [effectiveErrorSearch, refreshDashboard])

  const filteredTransactions = useMemo(() => {
    if (!metrics) return []
    if (!labelFilter) return metrics.transactions
    const q = labelFilter.toLowerCase()
    return metrics.transactions.filter((t) => t.label.toLowerCase().includes(q))
  }, [metrics, labelFilter])

  const usersChartData = metrics?.active_users_series ?? []

  const elapsedDisplay = useMemo(() => {
    if (!metrics) return '—'
    const scale = timelineScaleForSeconds(metrics.elapsed_seconds)
    return scale.formatWithUnit(metrics.elapsed_seconds)
  }, [metrics])

  const displayActiveThreads =
    metrics && metrics.active_threads > 0
      ? metrics.active_threads
      : lastActiveThreadsRef.current

  const isRunning =
    !stopping &&
    (metrics?.status === 'running' || metrics?.status === 'pending' || run?.status === 'running' || run?.status === 'pending')

  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (!metrics) return
    setSelectedLabels(new Set(metrics.transactions.map((t) => t.label)))
  }, [metrics])

  const clearSelection = useCallback(() => {
    setSelectedLabels(new Set())
    if (graphMode !== 'cumulative') {
      setGraphData([])
    }
    if (errorsGraphMode !== 'all') {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode, graphMode])

  async function stopTest() {
    if (!isRunning || stopping) return
    if (!window.confirm('Stop this test run and terminate JMeter?')) return
    setStopping(true)
    try {
      await api.cancelTestRun(id)
      toast.success(`Test run #${id} stopped`)
      const updated = await api.getTestRun(id)
      setRun(updated)
      setMetrics((prev) => (prev ? { ...prev, status: 'cancelled' } : prev))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to stop test')
      setStopping(false)
    }
  }

  return (
    <>
      <div className="breadcrumb">
        <Link to="/runs">Test Runs</Link> / <span>Run #{id}</span>
        {run && (
          <>
            {' '}/ <span>{run.release_name} → {run.build_name} → {run.scenario_name}</span>
          </>
        )}
      </div>
      <div className="dashboard-header">
        <h1 className="page-title dashboard-title">
          Live Dashboard — Run #{id}
          {(metrics || run) && (
            <span
              className={`badge badge-${stopping ? 'cancelled' : (metrics?.status || run?.status)}`}
              style={{ marginLeft: '0.75rem', verticalAlign: 'middle' }}
            >
              {stopping ? 'stopping…' : (metrics?.status || run?.status)}
            </span>
          )}
        </h1>
        {isRunning && (
          <button
            type="button"
            className="btn btn-danger dashboard-stop-btn"
            disabled={stopping}
            onClick={stopTest}
          >
            {stopping ? 'Stopping…' : 'Stop Test'}
          </button>
        )}
      </div>

      {metrics && (
        <div className="stat-row">
          <div className="stat"><div className="value">{displayActiveThreads}</div><div className="label">Active Users</div></div>
          <div className="stat"><div className="value">{metrics.total_samples}</div><div className="label">Samples</div></div>
          <div className="stat"><div className="value">{metrics.total_errors}</div><div className="label">Errors</div></div>
          <div className="stat"><div className="value">{elapsedDisplay}</div><div className="label">Elapsed</div></div>
        </div>
      )}

      <div className="grid-2">
        <ActiveUsersChart
          data={usersChartData}
          refreshIntervalSeconds={refreshIntervalSeconds}
        />
        <ResponseTimeChart
          graphData={graphData}
          graphMode={graphMode}
          selectedLabels={selectedLabels}
          refreshIntervalSeconds={refreshIntervalSeconds}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onGraphSelected={() => void loadGraph(false)}
          onCumulativeGraph={() => void loadGraph(true)}
        />
      </div>

      <ErrorsOverTimeChart
        errorsGraphData={errorsGraphData}
        errorsGraphMode={errorsGraphMode}
        selectedLabels={selectedLabels}
        totalErrors={metrics?.total_errors ?? 0}
        refreshIntervalSeconds={refreshIntervalSeconds}
        onAllErrors={() => void loadErrorsGraph(true)}
        onGraphSelectedErrors={() => void loadErrorsGraph(false)}
      />

      <div className="card">
        <h2>Aggregate Report (live)</h2>
        <div className="filters">
          <input placeholder="Filter transactions…" value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} />
        </div>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Label</th>
              <th># Samples</th>
              <th>Avg (ms)</th>
              <th>Min</th>
              <th>Max</th>
              <th>Median</th>
              <th>90% Line</th>
              <th>95% Line</th>
              <th>Error %</th>
              <th>Throughput</th>
            </tr>
          </thead>
          <tbody>
            {filteredTransactions.map((t: TransactionMetric) => (
              <tr
                key={t.label}
                className={selectedLabels.has(t.label) ? 'selected' : ''}
                onClick={() => toggleLabel(t.label)}
                style={{ cursor: 'pointer' }}
              >
                <td><input type="checkbox" checked={selectedLabels.has(t.label)} readOnly /></td>
                <td>{t.label}</td>
                <td>{t.samples}</td>
                <td>{t.avg_ms}</td>
                <td>{t.min_ms}</td>
                <td>{t.max_ms}</td>
                <td>{t.median_ms}</td>
                <td>{t.p90_ms}</td>
                <td>{t.p95_ms}</td>
                <td style={{ color: t.error_pct > 0 ? 'var(--danger)' : undefined }}>{t.error_pct}%</td>
                <td>{t.throughput}/s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Errors &amp; Exceptions</h2>
        <div className="filters">
          <input
            placeholder="Search errors (label, code, message, URL, thread)…"
            value={errorFilter}
            onChange={(e) => setErrorFilter(e.target.value)}
          />
        </div>
        {labelFilter.trim() && !errorFilter.trim() && (
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
            Also filtering by transaction search: &quot;{labelFilter.trim()}&quot;
          </p>
        )}
        <div className="error-panel">
          {displayedErrors.length ? displayedErrors.map((e, i) => (
            <div key={`${e.sample_index}-${e.timestamp}-${i}`} className="error-item">
              <div className="error-item-header">
                <div>
                  <strong>{e.label}</strong> [{e.response_code}] {e.response_message}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary error-view-btn"
                  onClick={() => setViewingError(e)}
                >
                  View
                </button>
              </div>
              {e.failure_message && <div>{e.failure_message}</div>}
              {e.url && <div style={{ color: 'var(--muted)' }}>{e.url}</div>}
              <div style={{ color: 'var(--muted)' }}>{e.thread_name}</div>
            </div>
          )) : (
            <p className="empty">
              {errorsLoading
                ? 'Loading errors…'
                : effectiveErrorSearch
                  ? 'No errors match your search'
                  : 'No errors'}
            </p>
          )}
        </div>
        {(metrics?.total_errors ?? 0) > 0 ? (
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
            Showing {displayedErrors.length} error(s)
            {effectiveErrorSearch ? ` matching "${effectiveErrorSearch}"` : ''}
            {' · '}{metrics?.total_errors ?? 0} total in run
          </p>
        ) : null}
      </div>

      {viewingError && (
        <ErrorDetailModal
          runId={id}
          error={viewingError}
          onClose={() => setViewingError(null)}
        />
      )}

      <JmeterLogConsole
        runId={id}
        isRunning={metrics?.status === 'running' || run?.status === 'running'}
        refreshIntervalMs={refreshPollMs}
        refreshGeneration={refreshGeneration}
      />

      <HostResourceChart
        runId={id}
        isRunning={metrics?.status === 'running' || run?.status === 'running'}
        refreshIntervalMs={refreshPollMs}
        refreshGeneration={refreshGeneration}
      />

      {run?.run_dir && (
        <div className="card">
          <h2>Artifacts</h2>
          <div className="toolbar">
            <a href={api.downloadUrl(id, 'results.jtl')} className="btn btn-secondary">Download JTL</a>
            <a href={api.downloadUrl(id, 'jmeter.log')} className="btn btn-secondary">Download Log</a>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Server path: {run.run_dir}
          </p>
        </div>
      )}
    </>
  )
}

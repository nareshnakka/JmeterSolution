import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { api } from '../api'
import JmeterLogConsole from '../components/JmeterLogConsole'
import HostResourceChart from '../components/HostResourceChart'
import { useToast } from '../components/Toast'
import type { ErrorSample, LiveMetrics, TestRun, TransactionMetric } from '../types'
import { maxTimeFromPoints, timelineScaleForSeconds } from '../utils/timeline'

const METRICS_POLL_MS = 10_000

type UsersPoint = { t: number; users: number }
type GraphSeries = { label: string; points: { t: number; avg_ms: number }[] }
type ErrorGraphSeries = { label: string; points: { t: number; errors: number }[] }

function mergeUsersSeries(prev: UsersPoint[], incoming: UsersPoint[]): UsersPoint[] {
  if (incoming.length === 0) return prev
  const byT = new Map(prev.map((p) => [p.t, p.users]))
  for (const p of incoming) {
    byT.set(p.t, p.users)
  }
  return Array.from(byT.entries())
    .map(([t, users]) => ({ t, users }))
    .sort((a, b) => a.t - b.t)
}

function mergeGraphSeries(prev: GraphSeries[], incoming: GraphSeries[]): GraphSeries[] {
  if (incoming.length === 0) return prev
  const byLabel = new Map<string, Map<number, number>>()
  for (const s of prev) {
    byLabel.set(s.label, new Map(s.points.map((p) => [p.t, p.avg_ms])))
  }
  for (const s of incoming) {
    if (!byLabel.has(s.label)) {
      byLabel.set(s.label, new Map())
    }
    const pointMap = byLabel.get(s.label)!
    for (const p of s.points) {
      pointMap.set(p.t, p.avg_ms)
    }
  }
  return Array.from(byLabel.entries())
    .map(([label, pointMap]) => ({
      label,
      points: Array.from(pointMap.entries())
        .map(([t, avg_ms]) => ({ t, avg_ms }))
        .sort((a, b) => a.t - b.t),
    }))
    .filter((s) => s.points.length > 0)
}

function mergeErrorsGraphSeries(prev: ErrorGraphSeries[], incoming: ErrorGraphSeries[]): ErrorGraphSeries[] {
  if (incoming.length === 0) return prev
  const byLabel = new Map<string, Map<number, number>>()
  for (const s of prev) {
    byLabel.set(s.label, new Map(s.points.map((p) => [p.t, p.errors])))
  }
  for (const s of incoming) {
    if (!byLabel.has(s.label)) {
      byLabel.set(s.label, new Map())
    }
    const pointMap = byLabel.get(s.label)!
    for (const p of s.points) {
      pointMap.set(p.t, p.errors)
    }
  }
  return Array.from(byLabel.entries())
    .map(([label, pointMap]) => ({
      label,
      points: Array.from(pointMap.entries())
        .map(([t, errors]) => ({ t, errors }))
        .sort((a, b) => a.t - b.t),
    }))
    .filter((s) => s.points.length > 0)
}

export default function LiveDashboard() {
  const { runId } = useParams()
  const id = Number(runId)
  const toast = useToast()
  const [run, setRun] = useState<TestRun | null>(null)
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [usersSeries, setUsersSeries] = useState<UsersPoint[]>([])
  const lastActiveThreadsRef = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set())
  const [labelFilter, setLabelFilter] = useState('')
  const [graphData, setGraphData] = useState<GraphSeries[]>([])
  const [graphMode, setGraphMode] = useState<'individual' | 'cumulative'>('individual')
  const [errorsGraphData, setErrorsGraphData] = useState<ErrorGraphSeries[]>([])
  const [errorsGraphMode, setErrorsGraphMode] = useState<'individual' | 'cumulative'>('cumulative')
  const [errorFilter, setErrorFilter] = useState('')
  const [displayedErrors, setDisplayedErrors] = useState<ErrorSample[]>([])
  const [errorsLoading, setErrorsLoading] = useState(false)

  useEffect(() => {
    api.getTestRun(id).then(setRun).catch(console.error)
  }, [id])

  useEffect(() => {
    lastActiveThreadsRef.current = 0
    setUsersSeries([])
    setMetrics(null)
    setGraphData([])
    setErrorsGraphData([])
    setDisplayedErrors([])
    setSelectedLabels(new Set())
    setGraphMode('individual')
    setErrorsGraphMode('cumulative')
    setErrorFilter('')
  }, [id])

  const applyMetrics = useCallback((m: LiveMetrics) => {
    if (m.active_threads > 0) {
      lastActiveThreadsRef.current = m.active_threads
    }
    setMetrics(m)
    setUsersSeries((prev) => mergeUsersSeries(prev, m.active_users_series ?? []))
  }, [])

  const fetchMetrics = useCallback(async () => {
    try {
      const m = await api.getMetrics(id)
      applyMetrics(m)
      if (m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled') {
        setStopping(false)
      }
    } catch {
      /* JTL may not exist yet at test start */
    }
  }, [id, applyMetrics])

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, METRICS_POLL_MS)
    return () => clearInterval(interval)
  }, [fetchMetrics])

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/test-runs/${id}`)

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'finished') {
        setStopping(false)
        fetchMetrics()
      }
    }

    return () => ws.close()
  }, [id, fetchMetrics])

  const effectiveErrorSearch = useMemo(
    () => (errorFilter.trim() || labelFilter.trim()),
    [errorFilter, labelFilter]
  )

  const fetchErrors = useCallback(async () => {
    setErrorsLoading(true)
    try {
      const data = await api.getRunErrors(
        id,
        effectiveErrorSearch || undefined
      )
      setDisplayedErrors(data)
    } catch {
      setDisplayedErrors([])
    } finally {
      setErrorsLoading(false)
    }
  }, [id, effectiveErrorSearch])

  useEffect(() => {
    void fetchErrors()
    const interval = setInterval(() => void fetchErrors(), METRICS_POLL_MS)
    return () => clearInterval(interval)
  }, [fetchErrors])

  const filteredTransactions = useMemo(() => {
    if (!metrics) return []
    if (!labelFilter) return metrics.transactions
    const q = labelFilter.toLowerCase()
    return metrics.transactions.filter((t) => t.label.toLowerCase().includes(q))
  }, [metrics, labelFilter])

  const hasErrorsGraphPoints = useMemo(
    () => errorsGraphData.some((s) => s.points.length > 0),
    [errorsGraphData]
  )

  const toggleLabel = (label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const selectAll = () => {
    if (!metrics) return
    setSelectedLabels(new Set(metrics.transactions.map((t) => t.label)))
  }

  const clearSelection = () => {
    setSelectedLabels(new Set())
    setGraphData([])
    if (errorsGraphMode !== 'cumulative') {
      setErrorsGraphData([])
    }
  }

  const loadGraph = useCallback(async (cumulative: boolean, merge = false) => {
    const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
    if (!cumulative && labels.length === 0) return
    setGraphMode(cumulative ? 'cumulative' : 'individual')
    try {
      const data = await api.getGraph(id, labels, cumulative)
      if (merge) {
        setGraphData((prev) => mergeGraphSeries(prev, data.series))
      } else {
        setGraphData(data.series)
      }
    } catch {
      /* graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const loadErrorsGraph = useCallback(async (cumulative: boolean, merge = false) => {
    const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
    if (!cumulative && labels.length === 0) return
    setErrorsGraphMode(cumulative ? 'cumulative' : 'individual')
    try {
      const data = await api.getErrorsGraph(id, labels, cumulative)
      if (merge) {
        setErrorsGraphData((prev) => mergeErrorsGraphSeries(prev, data.series))
      } else {
        setErrorsGraphData(data.series)
      }
    } catch {
      /* error graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const selectedLabelsKey = useMemo(() => Array.from(selectedLabels).sort().join('\0'), [selectedLabels])
  const graphIsActive = graphMode === 'cumulative' || selectedLabels.size > 0
  const errorsGraphIsActive =
    errorsGraphMode === 'cumulative' ||
    selectedLabels.size > 0 ||
    (metrics?.total_errors ?? 0) > 0

  useEffect(() => {
    if (graphMode === 'cumulative') {
      void loadGraph(true, false)
    } else if (selectedLabels.size > 0) {
      void loadGraph(false, false)
    } else {
      setGraphData([])
    }
  }, [graphMode, selectedLabelsKey, loadGraph])

  useEffect(() => {
    if (!graphIsActive) return
    const interval = setInterval(() => {
      void loadGraph(graphMode === 'cumulative', true)
    }, METRICS_POLL_MS)
    return () => clearInterval(interval)
  }, [graphIsActive, graphMode, loadGraph])

  useEffect(() => {
    if (errorsGraphMode === 'cumulative') {
      void loadErrorsGraph(true, false)
    } else if (selectedLabels.size > 0) {
      void loadErrorsGraph(false, false)
    } else {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode, selectedLabelsKey, loadErrorsGraph])

  useEffect(() => {
    if (metrics && metrics.total_errors > 0 && errorsGraphMode === 'cumulative' && !hasErrorsGraphPoints) {
      void loadErrorsGraph(true, false)
    }
  }, [metrics?.total_errors, errorsGraphMode, hasErrorsGraphPoints, loadErrorsGraph])

  useEffect(() => {
    if (!errorsGraphIsActive) return
    const interval = setInterval(() => {
      void loadErrorsGraph(errorsGraphMode === 'cumulative', true)
    }, METRICS_POLL_MS)
    return () => clearInterval(interval)
  }, [errorsGraphIsActive, errorsGraphMode, loadErrorsGraph])

  const usersChartData = usersSeries

  const usersTimeline = useMemo(
    () => timelineScaleForSeconds(maxTimeFromPoints(usersChartData)),
    [usersChartData]
  )

  const responseTimeline = useMemo(() => {
    const points = graphData.flatMap((s) => s.points)
    return timelineScaleForSeconds(maxTimeFromPoints(points))
  }, [graphData])

  const errorsTimeline = useMemo(() => {
    const points = errorsGraphData.flatMap((s) => s.points)
    return timelineScaleForSeconds(maxTimeFromPoints(points))
  }, [errorsGraphData])

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
        <div className="card">
          <h2>Active Users (live)</h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
            Refreshes every 10s
          </p>
          <div className="chart-wrap">
            {usersChartData.length > 0 ? (
              <ResponsiveContainer>
                <LineChart data={usersChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3a4f" />
                  <XAxis
                    dataKey="t"
                    stroke="#8b9cb3"
                    tickFormatter={(t) => usersTimeline.formatValue(Number(t))}
                    label={{ value: usersTimeline.axisLabel, position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis stroke="#8b9cb3" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#1a2332', border: '1px solid #2d3a4f' }}
                    labelFormatter={(label) => usersTimeline.formatWithUnit(Number(label))}
                  />
                  <Line
                    type="monotone"
                    dataKey="users"
                    stroke="#22c55e"
                    dot={false}
                    name="Active Users"
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">Waiting for data…</p>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Transaction Response Time</h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
            Refreshes every 10s when transactions are selected
          </p>
          <div className="toolbar">
            <button className="btn btn-secondary" onClick={selectAll}>Select All</button>
            <button className="btn btn-secondary" onClick={clearSelection} disabled={selectedLabels.size === 0}>
              Clear Selection
            </button>
            <button className="btn" onClick={() => loadGraph(false)} disabled={selectedLabels.size === 0}>
              Graph Selected
            </button>
            <button className="btn" onClick={() => loadGraph(true)}>Cumulative Graph</button>
          </div>
          <div className="chart-wrap">
            {graphData.length > 0 ? (
              <ResponsiveContainer>
                <LineChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3a4f" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    stroke="#8b9cb3"
                    tickFormatter={(t) => responseTimeline.formatValue(Number(t))}
                    label={{ value: responseTimeline.axisLabel, position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis stroke="#8b9cb3" unit=" ms" />
                  <Tooltip
                    contentStyle={{ background: '#1a2332', border: '1px solid #2d3a4f' }}
                    labelFormatter={(label) => responseTimeline.formatWithUnit(Number(label))}
                  />
                  <Legend />
                  {graphData.map((s, i) => (
                    <Line
                      key={s.label}
                      data={s.points}
                      type="monotone"
                      dataKey="avg_ms"
                      name={s.label}
                      stroke={['#3b82f6', '#f59e0b', '#22c55e', '#ef4444', '#a855f7'][i % 5]}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">Select transaction(s) to view response time graph</p>
            )}
          </div>
          {graphMode === 'individual' && selectedLabels.size > 0 && (
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
              Showing individual timeline for: {Array.from(selectedLabels).join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Errors Over Time</h2>
        <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
          Cumulative error count · auto-loads on open · refreshes every 10s
        </p>
        <div className="toolbar">
          <button className="btn" onClick={() => loadErrorsGraph(true, false)}>
            Cumulative Errors
          </button>
          <button
            className="btn"
            onClick={() => loadErrorsGraph(false, false)}
            disabled={selectedLabels.size === 0}
          >
            Graph Selected ({selectedLabels.size})
          </button>
        </div>
        <div className="chart-wrap">
          {hasErrorsGraphPoints ? (
            <ResponsiveContainer>
              <LineChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d3a4f" />
                <XAxis
                  dataKey="t"
                  type="number"
                  stroke="#8b9cb3"
                  tickFormatter={(t) => errorsTimeline.formatValue(Number(t))}
                  label={{ value: errorsTimeline.axisLabel, position: 'insideBottom', offset: -5 }}
                />
                <YAxis stroke="#8b9cb3" allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#1a2332', border: '1px solid #2d3a4f' }}
                  labelFormatter={(label) => errorsTimeline.formatWithUnit(Number(label))}
                />
                <Legend />
                {errorsGraphData.map((s, i) => (
                  <Line
                    key={s.label}
                    data={s.points}
                    type="monotone"
                    dataKey="errors"
                    name={s.label}
                    stroke={['#ef4444', '#f97316', '#f59e0b', '#dc2626', '#b91c1c'][i % 5]}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="empty">
              {(metrics?.total_errors ?? 0) > 0
                ? 'Loading error graph…'
                : 'No errors recorded yet'}
            </p>
          )}
        </div>
        {errorsGraphMode === 'individual' && selectedLabels.size > 0 && (
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
            Showing cumulative errors for: {Array.from(selectedLabels).join(', ')}
          </p>
        )}
      </div>

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
            <div key={`${e.timestamp}-${e.label}-${i}`} className="error-item">
              <strong>{e.label}</strong> [{e.response_code}] {e.response_message}
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

      <JmeterLogConsole
        runId={id}
        isRunning={metrics?.status === 'running' || run?.status === 'running'}
      />

      <HostResourceChart
        runId={id}
        isRunning={metrics?.status === 'running' || run?.status === 'running'}
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

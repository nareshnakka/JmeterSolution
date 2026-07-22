import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import ErrorDetailModal from '../components/ErrorDetailModal'
import DashboardSection from '../components/DashboardSection'
import JmeterLogConsole from '../components/JmeterLogConsole'
import HostResourceChart from '../components/HostResourceChart'
import AzureResourceChart from '../components/AzureResourceChart'
import {
  ActiveUsersChart,
  ErrorsOverTimeChart,
  PassFailPieChart,
  ResponseCodesTable,
  ResponseTimeChart,
  ThroughputChart,
} from '../components/live/LiveDashboardCharts'
import { useToast } from '../components/Toast'
import type { ErrorSample, LiveMetrics, TestRun, TransactionMetric, TransactionTotals } from '../types'
import { timelineScaleForSeconds } from '../utils/timeline'
import { formatLocalDateTime } from '../utils/datetime'
import { computeTransactionTotals, metricToTotals } from '../utils/transactionTotals'
import { filterTransactionsByKind, filterTransactionsByOutcome } from '../utils/transactionKind'
import { defaultSortDir, sortTransactions, type AggregateSortField, type SortDir } from '../utils/sortTransactions'
import {
  computeAggregateSummaryAvgs,
  DEFAULT_AGGREGATE_SUMMARY_CONFIG,
  type AggregateSummaryConfig,
} from '../utils/aggregateSummaryAvgs'
import { downloadAggregateReportCsv } from '../utils/exportAggregateCsv'
import { downloadAggregateRepoReport, prefetchExcelJS } from '../utils/exportAggregateRepoReport'
import type { AggregateKindFilter, AggregateOutcomeFilter } from '../types'

const DEFAULT_REFRESH_SECONDS = 10
const EXPORT_COOLDOWN_SECONDS = 30

type GraphSeries = { label: string; points: { t: number; avg_ms: number }[] }
type ErrorGraphSeries = { label: string; points: { t: number; errors: number }[] }

function SortableAggregateHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
}: {
  field: AggregateSortField
  label: string
  sortField: AggregateSortField
  sortDir: SortDir
  onSort: (field: AggregateSortField) => void
}) {
  const active = sortField === field
  return (
    <th className="compare-sortable" onClick={() => onSort(field)} title="Click to sort">
      {label}
      <span className="compare-sort-indicator">{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )
}

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
  const [outcomeFilter, setOutcomeFilter] = useState<AggregateOutcomeFilter>('pass')
  const [kindFilter, setKindFilter] = useState<AggregateKindFilter>('transaction')
  const [sortField, setSortField] = useState<AggregateSortField>('label')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [graphData, setGraphData] = useState<GraphSeries[]>([])
  const [graphMode, setGraphMode] = useState<'individual' | 'cumulative'>('cumulative')
  const [errorsGraphData, setErrorsGraphData] = useState<ErrorGraphSeries[]>([])
  const [errorsGraphMode, setErrorsGraphMode] = useState<'individual' | 'all'>('all')
  const [errorFilter, setErrorFilter] = useState('')
  const [displayedErrors, setDisplayedErrors] = useState<ErrorSample[]>([])
  const [errorsLoading, setErrorsLoading] = useState(false)
  const [viewingError, setViewingError] = useState<ErrorSample | null>(null)
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_SECONDS)
  const [aggregateSummaryConfig, setAggregateSummaryConfig] = useState<AggregateSummaryConfig>(
    DEFAULT_AGGREGATE_SUMMARY_CONFIG
  )
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [transactionTotals, setTransactionTotals] = useState<TransactionTotals | null>(null)
  const [metricsFetched, setMetricsFetched] = useState(false)
  const [exportCooldownUntil, setExportCooldownUntil] = useState(0)
  const [exportCooldownLeft, setExportCooldownLeft] = useState(0)
  const [exportingReport, setExportingReport] = useState(false)

  const refreshPollMs = refreshIntervalSeconds * 1000
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const wsConnectedRef = useRef(false)
  const graphIsActiveRef = useRef(true)
  const errorsGraphIsActiveRef = useRef(false)
  const errorSearchRef = useRef('')
  const skipSearchRefreshRef = useRef(true)

  const loadDashboardConfig = useCallback(() => {
    api.getConfig()
      .then((cfg) => {
        setRefreshIntervalSeconds(
          cfg.live_dashboard_refresh_interval_seconds ?? DEFAULT_REFRESH_SECONDS
        )
        setAggregateSummaryConfig({
          aggregate_total_avg_title:
            cfg.aggregate_total_avg_title ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_total_avg_title,
          aggregate_total_avg_filter:
            cfg.aggregate_total_avg_filter ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_total_avg_filter,
          aggregate_total_avg_exclude:
            cfg.aggregate_total_avg_exclude ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_total_avg_exclude,
          aggregate_load_avg_title:
            cfg.aggregate_load_avg_title ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_load_avg_title,
          aggregate_load_avg_filter:
            cfg.aggregate_load_avg_filter ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_load_avg_filter,
          aggregate_submit_avg_title:
            cfg.aggregate_submit_avg_title ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_submit_avg_title,
          aggregate_submit_avg_filter:
            cfg.aggregate_submit_avg_filter ?? DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_submit_avg_filter,
        })
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) return
    try {
      sessionStorage.setItem('jmeterAgent.lastLiveRunId', String(id))
    } catch {
      /* ignore */
    }
  }, [id])

  useEffect(() => {
    loadDashboardConfig()
  }, [loadDashboardConfig])

  useEffect(() => {
    // Preload ExcelJS while the dashboard is open so Export Report is not blocked
    // by downloading/parsing the large library on first click.
    const warm = () => prefetchExcelJS()
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }).requestIdleCallback
    if (ric) {
      const idleId = ric(warm, { timeout: 2500 })
      return () => {
        ;(window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idleId)
      }
    }
    const t = window.setTimeout(warm, 1200)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    setRun(null)
    api
      .getTestRun(id)
      .then((data) => {
        if (!cancelled) setRun(data)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    lastActiveThreadsRef.current = 0
    setMetrics(null)
    setMetricsFetched(false)
    setGraphData([])
    setErrorsGraphData([])
    setDisplayedErrors([])
    setSelectedLabels(new Set())
    setGraphMode('cumulative')
    setErrorsGraphMode('all')
    setErrorFilter('')
    setKindFilter('transaction')
    setOutcomeFilter('pass')
    setSortField('label')
    setSortDir('asc')
    setRefreshGeneration(0)
    skipSearchRefreshRef.current = true
  }, [id])

  const applyMetrics = useCallback((m: LiveMetrics) => {
    if (m.active_threads > 0) {
      lastActiveThreadsRef.current = m.active_threads
    }
    setMetrics((prev) => {
      if (!prev) return m

      const sameCounters =
        prev.status === m.status &&
        prev.active_threads === m.active_threads &&
        prev.total_samples === m.total_samples &&
        prev.total_errors === m.total_errors &&
        prev.transactions.length === m.transactions.length

      const usersTail = prev.active_users_series[prev.active_users_series.length - 1]
      const usersNext = m.active_users_series[m.active_users_series.length - 1]
      const tpPrev = prev.throughput_series[prev.throughput_series.length - 1]
      const tpNext = m.throughput_series[m.throughput_series.length - 1]

      const sameSeriesShape =
        prev.active_users_series.length === m.active_users_series.length &&
        prev.throughput_series.length === m.throughput_series.length &&
        (prev.response_codes?.length ?? 0) === (m.response_codes?.length ?? 0) &&
        usersTail?.t === usersNext?.t &&
        usersTail?.users === usersNext?.users &&
        tpPrev?.t === tpNext?.t &&
        tpPrev?.hits_per_sec === tpNext?.hits_per_sec

      // Elapsed-only heartbeat: keep previous heavy arrays.
      if (
        sameCounters &&
        sameSeriesShape &&
        Math.abs(prev.elapsed_seconds - m.elapsed_seconds) >= 0.5
      ) {
        return {
          ...prev,
          elapsed_seconds: m.elapsed_seconds,
          active_threads: m.active_threads,
          status: m.status,
        }
      }

      if (
        sameCounters &&
        sameSeriesShape &&
        Math.abs(prev.elapsed_seconds - m.elapsed_seconds) < 0.5
      ) {
        return prev
      }

      return m
    })
  }, [])

  const isTerminalStatus = useCallback((status?: string) => {
    return status === 'completed' || status === 'failed' || status === 'cancelled'
  }, [])

  const syncRunRecord = useCallback(async () => {
    try {
      const updated = await api.getTestRun(id)
      setRun(updated)
      return updated
    } catch {
      return null
    }
  }, [id])

  const handleTerminalStatus = useCallback(
    (status: string) => {
      setStopping(false)
      setMetrics((prev) => (prev ? { ...prev, status } : prev))
      setRun((prev) => (prev ? { ...prev, status } : prev))
      void syncRunRecord()
    },
    [syncRunRecord]
  )

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

  const refreshDashboard = useCallback(async (options?: {
    showErrorsLoading?: boolean
    skipMetrics?: boolean
    /** When false, skip heavy graph endpoints (used to stagger completed-report loads). */
    includeGraphs?: boolean
  }) => {
    if (refreshInFlightRef.current) {
      pendingRefreshRef.current = true
      return
    }
    refreshInFlightRef.current = true
    try {
      if (!options?.skipMetrics) {
        try {
          const m = await api.getMetrics(id)
          applyMetrics(m)
          if (isTerminalStatus(m.status)) {
            handleTerminalStatus(m.status)
          }
        } catch {
          /* JTL may not exist yet at test start */
        } finally {
          setMetricsFetched(true)
        }
      }

      const secondary: Promise<void>[] = []
      const skipErrorsFetch = wsConnectedRef.current && !errorSearchRef.current
      const includeGraphs = options?.includeGraphs !== false

      if (options?.showErrorsLoading) {
        setErrorsLoading(true)
      }
      if (!skipErrorsFetch) {
        secondary.push(
          api.getRunErrors(id, errorSearchRef.current || undefined)
            .then((data) => setDisplayedErrors(data))
            .catch(() => setDisplayedErrors([]))
            .finally(() => {
              if (options?.showErrorsLoading) setErrorsLoading(false)
            })
        )
      } else if (options?.showErrorsLoading) {
        setErrorsLoading(false)
      }

      if (includeGraphs && graphIsActiveRef.current) {
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

      if (includeGraphs && errorsGraphIsActiveRef.current) {
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
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        void refreshDashboard(options)
      }
    }
  }, [id, applyMetrics, graphMode, errorsGraphMode, selectedLabels, handleTerminalStatus, isTerminalStatus])

  const liveStatus = metrics?.status || run?.status
  const pollIntervalMs = refreshPollMs
  const runIsTerminal = isTerminalStatus(liveStatus)

  useEffect(() => {
    // Wait for run metadata so finished reports never start a live poll/WS stampede.
    if (!run) return

    let cancelled = false
    const terminal = runIsTerminal

    async function tick(showErrorsLoading: boolean, options?: { includeGraphs?: boolean }) {
      if (cancelled) return
      const skipMetrics =
        wsConnectedRef.current &&
        (liveStatus === 'running' || liveStatus === 'pending')
      await refreshDashboard({
        showErrorsLoading,
        skipMetrics,
        includeGraphs: options?.includeGraphs,
      })
    }

    // Finished reports: one HTTP connection for metrics + errors + default graphs.
    if (terminal) {
      void (async () => {
        setErrorsLoading(true)
        try {
          const report = await api.getTestRunReport(id)
          if (cancelled) return
          applyMetrics(report.metrics)
          if (isTerminalStatus(report.metrics.status)) {
            handleTerminalStatus(report.metrics.status)
          }
          setDisplayedErrors(report.errors ?? report.metrics.errors ?? [])
          setGraphData(report.response_time_graph?.series ?? [])
          setErrorsGraphData(report.errors_graph?.series ?? [])
          setGraphMode('cumulative')
          setErrorsGraphMode('all')
          setMetricsFetched(true)
          setRefreshGeneration((g) => g + 1)
        } catch (e) {
          console.error(e)
          // Fallback: still try metrics-only so the page is not empty.
          if (!cancelled) {
            await tick(true, { includeGraphs: false })
          }
        } finally {
          if (!cancelled) setErrorsLoading(false)
        }
      })()
      return () => {
        cancelled = true
      }
    }

    void tick(true, { includeGraphs: true })

    const interval = setInterval(() => void tick(false, { includeGraphs: true }), pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [
    id,
    pollIntervalMs,
    refreshDashboard,
    liveStatus,
    runIsTerminal,
    run,
    applyMetrics,
    handleTerminalStatus,
    isTerminalStatus,
  ])

  useEffect(() => {
    // Finished reports do not need a live WebSocket.
    if (!run || runIsTerminal) return

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/test-runs/${id}`)

    ws.onopen = () => {
      wsConnectedRef.current = true
    }
    ws.onclose = () => {
      wsConnectedRef.current = false
    }

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'metrics' && msg.data) {
        applyMetrics(msg.data as LiveMetrics)
        setMetricsFetched(true)
        if (!errorSearchRef.current && (msg.data as LiveMetrics).errors?.length) {
          setDisplayedErrors((msg.data as LiveMetrics).errors)
        }
        if (isTerminalStatus(msg.data.status)) {
          handleTerminalStatus(msg.data.status)
          void refreshDashboard()
        }
      }
      if (msg.type === 'finished') {
        const status = msg.data?.status as string | undefined
        if (status) {
          handleTerminalStatus(status)
        } else {
          setStopping(false)
        }
        void refreshDashboard()
      }
    }

    return () => ws.close()
  }, [id, run, runIsTerminal, applyMetrics, refreshDashboard, handleTerminalStatus, isTerminalStatus])

  useEffect(() => {
    if (!run) return

    // Terminal default charts arrive in the report bundle — only refetch when the user
    // changes mode/labels (avoids extra connections that time out under parallel tabs).
    if (runIsTerminal) {
      const customSelection = graphMode !== 'cumulative' || selectedLabels.size > 0
      if (!customSelection) return
    }

    let cancelled = false
    const kick = () => {
      if (cancelled) return
      // Default: always plot Total Avg (cumulative) unless user chose individual labels.
      if (graphMode === 'cumulative') {
        void loadGraph(true)
      } else if (selectedLabels.size > 0) {
        void loadGraph(false)
      } else {
        // No selection in individual mode — fall back to Total Avg so the chart is never empty by default.
        void loadGraph(true)
      }
    }
    kick()
    return () => {
      cancelled = true
    }
  }, [graphMode, selectedLabelsKey, loadGraph, selectedLabels, runIsTerminal, run])

  useEffect(() => {
    if (!run) return

    if (runIsTerminal) {
      const customSelection = errorsGraphMode !== 'all' || selectedLabels.size > 0
      if (!customSelection) return
    }

    let cancelled = false
    const kick = () => {
      if (cancelled) return
      if (errorsGraphMode === 'all') {
        void loadErrorsGraph(true)
      } else if (selectedLabels.size > 0) {
        void loadErrorsGraph(false)
      } else {
        setErrorsGraphData([])
      }
    }
    kick()
    return () => {
      cancelled = true
    }
  }, [errorsGraphMode, selectedLabelsKey, loadErrorsGraph, selectedLabels, runIsTerminal, run])

  useEffect(() => {
    if (skipSearchRefreshRef.current) {
      skipSearchRefreshRef.current = false
      return
    }
    void refreshDashboard({ showErrorsLoading: true })
  }, [effectiveErrorSearch, refreshDashboard])

  const filteredTransactions = useMemo(() => {
    if (!metrics) return []
    let rows = filterTransactionsByKind(metrics.transactions, kindFilter)
    rows = filterTransactionsByOutcome(rows, outcomeFilter)
    if (!labelFilter) return rows
    const q = labelFilter.toLowerCase()
    return rows.filter((t) => t.label.toLowerCase().includes(q))
  }, [metrics, labelFilter, kindFilter, outcomeFilter])

  useEffect(() => {
    if (!metrics || filteredTransactions.length === 0) {
      setTransactionTotals(null)
      return
    }
    // Outcome filters are applied on aggregated label rows; recompute TOTAL from the
    // visible set so Pass/Fail does not pull in excluded labels via the API.
    // Finished reports also compute locally to avoid an extra connection after the bundle.
    if (outcomeFilter !== 'all' || runIsTerminal) {
      setTransactionTotals(
        computeTransactionTotals(filteredTransactions, metrics.elapsed_seconds)
      )
      return
    }
    let cancelled = false
    void api
      .getAggregateTotal(id, kindFilter, labelFilter.trim() || undefined)
      .then((total) => {
        if (!cancelled) setTransactionTotals(metricToTotals(total))
      })
      .catch(() => {
        if (!cancelled) {
          setTransactionTotals(
            computeTransactionTotals(filteredTransactions, metrics.elapsed_seconds)
          )
        }
      })
    return () => {
      cancelled = true
    }
    // Re-fetch totals only when sample count or filters change — not on every elapsed tick.
  }, [
    id,
    metrics?.total_samples,
    metrics?.elapsed_seconds,
    kindFilter,
    outcomeFilter,
    labelFilter,
    filteredTransactions,
    runIsTerminal,
  ])

  const sortedTransactions = useMemo(
    () => sortTransactions(filteredTransactions, sortField, sortDir),
    [filteredTransactions, sortField, sortDir]
  )

  const aggregateSummaryAvgs = useMemo(
    () => computeAggregateSummaryAvgs(metrics?.transactions, aggregateSummaryConfig),
    [metrics?.transactions, aggregateSummaryConfig]
  )

  const handleAggregateSort = useCallback((field: AggregateSortField) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(defaultSortDir(field))
    }
  }, [sortField])

  useEffect(() => {
    if (exportCooldownUntil <= 0) {
      setExportCooldownLeft(0)
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((exportCooldownUntil - Date.now()) / 1000))
      setExportCooldownLeft(left)
      if (left <= 0) setExportCooldownUntil(0)
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [exportCooldownUntil])

  const beginExportCooldown = useCallback(() => {
    setExportCooldownUntil(Date.now() + EXPORT_COOLDOWN_SECONDS * 1000)
  }, [])

  const exportOnCooldown = exportCooldownLeft > 0 || exportingReport

  const handleExportAggregateCsv = useCallback(() => {
    if (exportOnCooldown) return
    const ok = downloadAggregateReportCsv({
      rows: sortedTransactions,
      totals: transactionTotals,
      runId: id,
      kindFilter,
      outcomeFilter,
      labelFilter,
    })
    if (ok) {
      beginExportCooldown()
      toast.success(
        `Aggregate report exported as CSV. Next export available in ${EXPORT_COOLDOWN_SECONDS}s.`
      )
    } else {
      toast.error('No rows to export')
    }
  }, [
    exportOnCooldown,
    sortedTransactions,
    transactionTotals,
    id,
    kindFilter,
    outcomeFilter,
    labelFilter,
    beginExportCooldown,
    toast,
  ])

  const handleExportAggregateRepo = useCallback(async () => {
    if (exportOnCooldown) return
    setExportingReport(true)
    toast.info('Preparing Excel report…')
    try {
      const allRows = metrics?.transactions ?? []
      const ok = await downloadAggregateRepoReport({
        transactions: allRows,
        tableRows: sortedTransactions,
        meta: {
          run,
          metrics,
          config: aggregateSummaryConfig,
        },
        runId: id,
      })
      if (ok) {
        beginExportCooldown()
        toast.success(
          `Report exported. Next export available in ${EXPORT_COOLDOWN_SECONDS}s.`
        )
      } else {
        toast.error(
          'No rows to export. Switch Outcome to All or Type to All if the table is empty.'
        )
      }
    } catch (err) {
      console.error('Export Report failed', err)
      const message = err instanceof Error && err.message ? err.message : 'Failed to export report'
      toast.error(message)
    } finally {
      setExportingReport(false)
    }
  }, [
    exportOnCooldown,
    metrics,
    run,
    aggregateSummaryConfig,
    id,
    sortedTransactions,
    beginExportCooldown,
    toast,
  ])

  const usersChartData = metrics?.active_users_series ?? []
  const throughputChartData = metrics?.throughput_series ?? []

  useEffect(() => {
    if (!metrics) return
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
    return () => window.cancelAnimationFrame(id)
  }, [metrics, graphData, errorsGraphData, usersChartData, throughputChartData])

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
    !isTerminalStatus(liveStatus) &&
    (liveStatus === 'running' || liveStatus === 'pending')

  const hasResults =
    (metrics?.total_samples ?? 0) > 0 || (metrics?.transactions?.length ?? 0) > 0
  const showResultsLoading =
    !hasResults &&
    (!metricsFetched || isRunning || liveStatus === 'pending' || liveStatus === 'running' || stopping)

  const startTimeDisplay = useMemo(
    () => formatLocalDateTime(run?.started_at),
    [run?.started_at]
  )

  const endTimeDisplay = useMemo(() => {
    if (run?.finished_at) return formatLocalDateTime(run.finished_at)
    if (isRunning) return 'In progress'
    return '—'
  }, [run?.finished_at, isRunning])

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
    // Return to default Total Avg graph when clearing selection.
    setGraphMode('cumulative')
    if (errorsGraphMode !== 'all') {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode])

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
              className={`badge badge-${stopping ? 'cancelled' : liveStatus}`}
              style={{ marginLeft: '0.75rem', verticalAlign: 'middle' }}
            >
              {stopping ? 'stopping…' : liveStatus}
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
      {run?.notes?.trim() && (
        <p className="dashboard-run-description">
          <span className="dashboard-run-description-label">Description</span>
          {run.notes.trim()}
        </p>
      )}

      {showResultsLoading && (
        <div className="dashboard-results-loading" role="status" aria-live="polite">
          <span className="dashboard-results-spinner" aria-hidden="true" />
          <div className="dashboard-results-loading-text">
            <strong>Waiting for results…</strong>
            <span>
              {isRunning || liveStatus === 'pending' || liveStatus === 'running'
                ? 'JMeter is running. Aggregate metrics will appear when the first samples are recorded.'
                : 'Loading dashboard metrics…'}
            </span>
          </div>
        </div>
      )}

      {(run || metrics) && (
        <DashboardSection
          title="Summary"
          meta={
            metrics
              ? `${displayActiveThreads} users · ${metrics.total_samples} samples · ${metrics.total_errors} errors`
              : undefined
          }
          bodyClassName="dashboard-summary-body"
        >
          <div className="dashboard-stat-row">
          <div className="stat stat-run-times">
            <div className="label">Run Times</div>
            <div className="stat-run-time-rows">
              <div className="stat-run-time-row">
                <span className="stat-run-time-label">Start</span>
                <span className="stat-run-time-value">{startTimeDisplay}</span>
              </div>
              <div className="stat-run-time-row">
                <span className="stat-run-time-label">End</span>
                <span className="stat-run-time-value">{endTimeDisplay}</span>
              </div>
            </div>
          </div>
          <div className="stat"><div className="label">Active Users</div><div className="value">{metrics ? displayActiveThreads : '—'}</div></div>
          <div className="stat"><div className="label">Samples</div><div className="value">{metrics?.total_samples ?? '—'}</div></div>
          <div className="stat"><div className="label">Errors</div><div className="value">{metrics?.total_errors ?? '—'}</div></div>
          <div className="stat"><div className="label">Elapsed</div><div className="value">{metrics ? elapsedDisplay : '—'}</div></div>
          {metrics ? (
            <PassFailPieChart
              totalSamples={metrics.total_samples}
              totalErrors={metrics.total_errors}
            />
          ) : (
            <div className="stat dashboard-pass-fail-chart dashboard-pass-fail-placeholder">
              <div className="dashboard-pass-fail-title">Pass / Fail</div>
              <p className="empty dashboard-pass-fail-empty">Waiting…</p>
            </div>
          )}
          </div>
        </DashboardSection>
      )}

      <div className="grid-2">
        <ActiveUsersChart
          data={usersChartData}
          elapsedSeconds={metrics?.elapsed_seconds}
          capTimelineToData={!isRunning}
          refreshIntervalSeconds={refreshIntervalSeconds}
        />
        <ThroughputChart
          data={throughputChartData}
          elapsedSeconds={metrics?.elapsed_seconds}
          capTimelineToData={!isRunning}
          refreshIntervalSeconds={refreshIntervalSeconds}
        />
      </div>

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

      <ErrorsOverTimeChart
        errorsGraphData={errorsGraphData}
        errorsGraphMode={errorsGraphMode}
        selectedLabels={selectedLabels}
        totalErrors={metrics?.total_errors ?? 0}
        refreshIntervalSeconds={refreshIntervalSeconds}
        onAllErrors={() => void loadErrorsGraph(true)}
        onGraphSelectedErrors={() => void loadErrorsGraph(false)}
      />

      <DashboardSection
        title="Aggregate Report (live)"
        meta={
          metrics
            ? `${filteredTransactions.length} row(s) · ${metrics.total_samples} samples`
            : undefined
        }
      >
        <div className="aggregate-report-filters">
          <div className="aggregate-filter-groups">
            <div className="aggregate-kind-filters" role="radiogroup" aria-label="Outcome">
              <span className="aggregate-filter-group-label">Outcome</span>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-outcome"
                  value="pass"
                  checked={outcomeFilter === 'pass'}
                  onChange={() => setOutcomeFilter('pass')}
                />
                Pass
              </label>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-outcome"
                  value="fail"
                  checked={outcomeFilter === 'fail'}
                  onChange={() => setOutcomeFilter('fail')}
                />
                Fail
              </label>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-outcome"
                  value="all"
                  checked={outcomeFilter === 'all'}
                  onChange={() => setOutcomeFilter('all')}
                />
                All
              </label>
            </div>
            <div className="aggregate-kind-filters" role="radiogroup" aria-label="Sample type">
              <span className="aggregate-filter-group-label">Type</span>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-kind"
                  value="transaction"
                  checked={kindFilter === 'transaction'}
                  onChange={() => setKindFilter('transaction')}
                />
                Transactions
              </label>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-kind"
                  value="request"
                  checked={kindFilter === 'request'}
                  onChange={() => setKindFilter('request')}
                />
                APIs / Requests
              </label>
              <label className="aggregate-kind-option">
                <input
                  type="radio"
                  name="aggregate-kind"
                  value="all"
                  checked={kindFilter === 'all'}
                  onChange={() => setKindFilter('all')}
                />
                All
              </label>
            </div>
          </div>
          <input
            className="aggregate-label-filter"
            placeholder="Filter by label…"
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
          />
          <div className="aggregate-summary-stats" aria-label="Transaction average summary">
            {aggregateSummaryAvgs.map((item) => (
              <div key={item.title} className="aggregate-summary-stat">
                <span className="aggregate-summary-stat-label">{item.title}</span>
                <span className="aggregate-summary-stat-value">
                  {item.avg_ms != null ? `${item.avg_ms} ms` : '—'}
                </span>
              </div>
            ))}
          </div>
          <div className="aggregate-export-actions">
            <button
              type="button"
              className="btn btn-secondary aggregate-export-btn"
              disabled={sortedTransactions.length === 0 || exportOnCooldown}
              onClick={handleExportAggregateCsv}
              title={
                exportCooldownLeft > 0
                  ? `Export available again in ${exportCooldownLeft}s`
                  : 'Export filtered rows as CSV'
              }
            >
              {exportCooldownLeft > 0 ? `Export CSV (${exportCooldownLeft}s)` : 'Export CSV'}
            </button>
            <button
              type="button"
              className="btn btn-secondary aggregate-export-btn"
              disabled={
                exportOnCooldown ||
                (sortedTransactions.length === 0 && (metrics?.transactions?.length ?? 0) === 0)
              }
              onClick={handleExportAggregateRepo}
              title={
                exportCooldownLeft > 0
                  ? `Export available again in ${exportCooldownLeft}s`
                  : exportingReport
                    ? 'Preparing Excel report…'
                    : 'Excel report with summary averages and Label, Samples, Response Time'
              }
            >
              {exportingReport
                ? 'Exporting…'
                : exportCooldownLeft > 0
                  ? `Export Report (${exportCooldownLeft}s)`
                  : 'Export Report'}
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th></th>
              <SortableAggregateHeader
                field="label"
                label="Label"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="samples"
                label="# Samples"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="avg_ms"
                label="Avg (ms)"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="min_ms"
                label="Min"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="max_ms"
                label="Max"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="median_ms"
                label="Median"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p90_ms"
                label="90% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p95_ms"
                label="95% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p99_ms"
                label="99% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="error_pct"
                label="Error %"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="throughput"
                label="Throughput"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
            </tr>
          </thead>
          <tbody>
            {sortedTransactions.map((t: TransactionMetric) => (
              <tr
                key={`${t.label}-${t.kind ?? 'unknown'}`}
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
                <td>{t.p99_ms}</td>
                <td style={{ color: t.error_pct > 0 ? 'var(--danger)' : undefined }}>{t.error_pct}%</td>
                <td>{t.throughput}/s</td>
              </tr>
            ))}
          </tbody>
          {transactionTotals && (
            <tfoot>
              <tr className="aggregate-total-row">
                <td />
                <td><strong>TOTAL</strong></td>
                <td><strong>{transactionTotals.samples}</strong></td>
                <td><strong>{transactionTotals.avg_ms}</strong></td>
                <td><strong>{transactionTotals.min_ms}</strong></td>
                <td><strong>{transactionTotals.max_ms}</strong></td>
                <td><strong>{transactionTotals.median_ms}</strong></td>
                <td><strong>{transactionTotals.p90_ms}</strong></td>
                <td><strong>{transactionTotals.p95_ms}</strong></td>
                <td><strong>{transactionTotals.p99_ms}</strong></td>
                <td style={{ color: transactionTotals.error_pct > 0 ? 'var(--danger)' : undefined }}>
                  <strong>{transactionTotals.error_pct}%</strong>
                </td>
                <td><strong>{transactionTotals.throughput}/s</strong></td>
              </tr>
            </tfoot>
          )}
        </table>
        {metrics && filteredTransactions.length === 0 && (
          <p className="empty">No rows match the current filters</p>
        )}
      </DashboardSection>

      <div className="grid-2 dashboard-details-grid">
      <DashboardSection
        title="Errors & Exceptions"
        meta={`${displayedErrors.length} shown · ${metrics?.total_errors ?? 0} total`}
      >
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
      </DashboardSection>

      <ResponseCodesTable rows={metrics?.response_codes ?? []} />
      </div>

      {viewingError && (
        <ErrorDetailModal
          runId={id}
          error={viewingError}
          onClose={() => setViewingError(null)}
        />
      )}

      {/* Defer secondary fetches until the report body is ready — frees browser connections. */}
      {(!runIsTerminal || metricsFetched) && (
        <>
          <JmeterLogConsole
            runId={id}
            isRunning={!isTerminalStatus(liveStatus) && liveStatus === 'running'}
            refreshIntervalMs={refreshPollMs}
            refreshGeneration={refreshGeneration}
          />

          <HostResourceChart
            runId={id}
            isRunning={!isTerminalStatus(liveStatus) && liveStatus === 'running'}
            refreshIntervalMs={refreshPollMs}
            refreshGeneration={refreshGeneration}
          />

          <AzureResourceChart
            runId={id}
            isRunning={!isTerminalStatus(liveStatus) && liveStatus === 'running'}
            refreshIntervalMs={refreshPollMs}
            refreshGeneration={refreshGeneration}
          />
        </>
      )}

      {run?.run_dir && (
        <DashboardSection title="Artifacts" defaultExpanded={false}>
          <div className="toolbar">
            <a href={api.downloadUrl(id, 'results.jtl')} className="btn btn-secondary">Download JTL</a>
            <a href={api.downloadUrl(id, 'errors-trace.jtl')} className="btn btn-secondary">Download Error Trace JTL</a>
            <a href={api.downloadUrl(id, 'jmeter.log')} className="btn btn-secondary">Download Log</a>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Server path: {run.run_dir}
          </p>
        </DashboardSection>
      )}
    </>
  )
}

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { api } from '../api'
import DashboardSection from './DashboardSection'
import type { AzureResources } from '../types'
import { downsamplePoints } from '../utils/chartDownsample'
import { maxTimeFromPoints, timelineScaleForSeconds } from '../utils/timeline'
import { chartTheme } from '../utils/chartTheme'
import { computeAzureResourceAverages } from '../utils/azureResourceAverages'

const COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f']

interface AzureResourceChartProps {
  runId: number
  isRunning: boolean
  refreshIntervalMs?: number
  refreshGeneration?: number
}

type MetricKind = 'cpu' | 'cpu_max' | 'mem'

function seriesKey(server: string, kind: MetricKind): string {
  return `${server}__${kind}`
}

function seriesLabel(server: string, kind: MetricKind): string {
  if (kind === 'cpu') return `${server} CPU Avg`
  if (kind === 'cpu_max') return `${server} CPU Max`
  return `${server} Mem`
}

function AzureResourceChart({
  runId,
  isRunning,
  refreshIntervalMs,
  refreshGeneration,
}: AzureResourceChartProps) {
  const [resources, setResources] = useState<AzureResources | null>(null)
  /** Series keys that are hidden from the chart. Empty = show all. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  const pollMs = Math.max(refreshIntervalMs ?? 15_000, 15_000)

  const loadResources = useCallback(async () => {
    try {
      const data = await api.getRunAzureResources(runId)
      setResources(data)
    } catch {
      /* file may not exist yet */
    }
  }, [runId])

  useEffect(() => {
    void loadResources()
  }, [loadResources])

  useEffect(() => {
    if (refreshGeneration !== undefined) return
    if (!isRunning) return
    const interval = setInterval(() => void loadResources(), pollMs)
    return () => clearInterval(interval)
  }, [loadResources, pollMs, refreshGeneration, isRunning])

  useEffect(() => {
    if (refreshGeneration === undefined || refreshGeneration === 0) return
    if (!isRunning) return
    void loadResources()
  }, [refreshGeneration, loadResources, isRunning])

  const serverNames = useMemo(() => {
    const names = new Set<string>()
    for (const t of resources?.targets ?? []) names.add(t.name)
    for (const sample of resources?.samples ?? []) {
      Object.keys(sample.servers ?? {}).forEach((n) => names.add(n))
    }
    return Array.from(names)
  }, [resources])

  const allSeriesKeys = useMemo(
    () =>
      serverNames.flatMap((name) => [
        seriesKey(name, 'cpu'),
        seriesKey(name, 'cpu_max'),
        seriesKey(name, 'mem'),
      ]),
    [serverNames],
  )

  // Drop hidden keys that no longer exist when servers change.
  useEffect(() => {
    setHidden((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((k) => allSeriesKeys.includes(k)))
      return next.size === prev.size ? prev : next
    })
  }, [allSeriesKeys])

  const chartData = useMemo(() => {
    const rows = (resources?.samples ?? []).map((s) => {
      const row: Record<string, number | null> = { t: s.t }
      for (const name of serverNames) {
        const m = s.servers?.[name]
        row[seriesKey(name, 'cpu')] = m?.cpu_percent ?? null
        row[seriesKey(name, 'cpu_max')] = m?.cpu_max_percent ?? null
        row[seriesKey(name, 'mem')] = m?.memory_percent ?? null
      }
      return row
    })
    return downsamplePoints(rows as { t: number }[])
  }, [resources, serverNames])

  const timeline = useMemo(
    () => timelineScaleForSeconds(maxTimeFromPoints(chartData)),
    [chartData],
  )

  const averages = useMemo(() => computeAzureResourceAverages(resources), [resources])

  const latest = resources?.samples?.[resources.samples.length - 1]
  const hasData = chartData.length > 0 && serverNames.length > 0
  const hasTargets = (resources?.targets?.length ?? 0) > 0 || serverNames.length > 0

  const metaParts: string[] = []
  if (latest) {
    for (const name of serverNames) {
      const m = latest.servers?.[name]
      if (!m) continue
      const cpu = m.cpu_percent != null ? `${m.cpu_percent}%` : '—'
      const cpuMax = m.cpu_max_percent != null ? `${m.cpu_max_percent}%` : '—'
      const mem = m.memory_percent != null ? `${m.memory_percent}%` : '—'
      metaParts.push(`${name}: CPU ${cpu} (max ${cpuMax}) · Mem ${mem}`)
    }
  }

  const isHidden = (key: string) => hidden.has(key)

  const toggleSeries = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const setKindVisible = (kind: MetricKind, visible: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev)
      for (const name of serverNames) {
        const key = seriesKey(name, kind)
        if (visible) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const setServerVisible = (server: string, visible: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev)
      for (const kind of ['cpu', 'cpu_max', 'mem'] as MetricKind[]) {
        const key = seriesKey(server, kind)
        if (visible) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const showAll = () => setHidden(new Set())
  const hideAll = () => setHidden(new Set(allSeriesKeys))

  const serverFullyVisible = (server: string) =>
    !isHidden(seriesKey(server, 'cpu')) &&
    !isHidden(seriesKey(server, 'cpu_max')) &&
    !isHidden(seriesKey(server, 'mem'))

  const kindFullyVisible = (kind: MetricKind) =>
    serverNames.every((name) => !isHidden(seriesKey(name, kind)))

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${Math.round(sec)}s`
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return s ? `${m}m ${s}s` : `${m}m`
  }

  return (
    <DashboardSection
      title="Azure Target Servers (CPU / Memory)"
      meta={metaParts.length ? metaParts.join(' · ') : undefined}
      defaultExpanded={hasData}
    >
      <p className="dashboard-section-hint">
        Metrics are recorded only while the test is running
        {isRunning ? ' · updating live' : ' · recording stopped when the run finished'}.
        Click a legend item or use the toggles to show/hide series.
      </p>

      {hasData ? (
        <>
          <div className="azure-metric-toggles">
            <div className="azure-metric-toggle-group">
              <span className="azure-metric-toggle-label">Quick</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={showAll}>
                Show all
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={hideAll}>
                Hide all
              </button>
              <button
                type="button"
                className={`btn btn-secondary btn-sm${kindFullyVisible('cpu') ? ' is-active' : ''}`}
                onClick={() => setKindVisible('cpu', !kindFullyVisible('cpu'))}
              >
                CPU Avg
              </button>
              <button
                type="button"
                className={`btn btn-secondary btn-sm${kindFullyVisible('cpu_max') ? ' is-active' : ''}`}
                onClick={() => setKindVisible('cpu_max', !kindFullyVisible('cpu_max'))}
              >
                CPU Max
              </button>
              <button
                type="button"
                className={`btn btn-secondary btn-sm${kindFullyVisible('mem') ? ' is-active' : ''}`}
                onClick={() => setKindVisible('mem', !kindFullyVisible('mem'))}
              >
                Memory
              </button>
            </div>
            <div className="azure-metric-toggle-group">
              <span className="azure-metric-toggle-label">Servers</span>
              {serverNames.map((name, i) => (
                <label key={name} className="azure-metric-check">
                  <input
                    type="checkbox"
                    checked={serverFullyVisible(name)}
                    onChange={(e) => setServerVisible(name, e.target.checked)}
                  />
                  <span style={{ borderLeft: `3px solid ${COLORS[i % COLORS.length]}`, paddingLeft: 6 }}>
                    {name}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  type="number"
                  stroke={chartTheme.axis}
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t) => timeline.formatValue(Number(t))}
                  label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
                />
                <YAxis domain={[0, 100]} unit="%" stroke={chartTheme.axis} width={42} />
                <Tooltip
                  labelFormatter={(v) => timeline.formatValue(Number(v))}
                  formatter={(value) => {
                    if (value == null || value === '') return ['—', '']
                    const n = typeof value === 'number' ? value : Number(value)
                    return [Number.isFinite(n) ? `${n}%` : '—', '']
                  }}
                />
                <Legend
                  wrapperStyle={{ cursor: 'pointer' }}
                  onClick={(entry) => {
                    const key = String(entry.dataKey ?? '')
                    if (key) toggleSeries(key)
                  }}
                />
                {serverNames.map((name, i) => {
                  const key = seriesKey(name, 'cpu')
                  return (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={seriesLabel(name, 'cpu')}
                      stroke={COLORS[i % COLORS.length]}
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                      hide={isHidden(key)}
                      isAnimationActive={false}
                    />
                  )
                })}
                {serverNames.map((name, i) => {
                  const key = seriesKey(name, 'cpu_max')
                  return (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={seriesLabel(name, 'cpu_max')}
                      stroke={COLORS[i % COLORS.length]}
                      strokeDasharray="2 2"
                      dot={false}
                      strokeWidth={1.75}
                      connectNulls
                      hide={isHidden(key)}
                      isAnimationActive={false}
                    />
                  )
                })}
                {serverNames.map((name, i) => {
                  const key = seriesKey(name, 'mem')
                  return (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={seriesLabel(name, 'mem')}
                      stroke={COLORS[i % COLORS.length]}
                      strokeDasharray="4 3"
                      dot={false}
                      strokeWidth={1.5}
                      connectNulls
                      hide={isHidden(key)}
                      isAnimationActive={false}
                    />
                  )
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="azure-avg-table-wrap">
            <h3 className="azure-avg-title">
              Average / Max over available duration
              {averages.durationSec > 0 ? ` (${formatDuration(averages.durationSec)})` : ''}
              {averages.samplePoints ? ` · ${averages.samplePoints} sample(s)` : ''}
            </h3>
            <table className="data-table azure-avg-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Avg CPU %</th>
                  <th>Max CPU %</th>
                  <th>Avg Memory %</th>
                  <th>Samples</th>
                </tr>
              </thead>
              <tbody>
                {averages.servers.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.cpuAvg != null ? row.cpuAvg.toFixed(1) : '—'}</td>
                    <td>{row.cpuMax != null ? row.cpuMax.toFixed(1) : '—'}</td>
                    <td>{row.memAvg != null ? row.memAvg.toFixed(1) : '—'}</td>
                    <td>{row.sampleCount || '—'}</td>
                  </tr>
                ))}
                <tr className="azure-avg-total">
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td>
                    <strong>{averages.totalCpu != null ? averages.totalCpu.toFixed(1) : '—'}</strong>
                  </td>
                  <td>
                    <strong>
                      {averages.totalCpuMax != null ? averages.totalCpuMax.toFixed(1) : '—'}
                    </strong>
                  </td>
                  <td>
                    <strong>{averages.totalMem != null ? averages.totalMem.toFixed(1) : '—'}</strong>
                  </td>
                  <td>
                    <strong>{averages.samplePoints || '—'}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="empty">
          {isRunning
            ? hasTargets
              ? 'Collecting first Azure CPU/Memory sample…'
              : 'Waiting for Azure sampling to start… Click Save Azure Settings if you just configured VMs, or restart the test.'
            : 'No Azure server metrics stored for this run'}
        </p>
      )}
    </DashboardSection>
  )
}

export default memo(AzureResourceChart)

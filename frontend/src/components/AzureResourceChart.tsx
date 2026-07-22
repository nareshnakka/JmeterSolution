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

const COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f']

interface AzureResourceChartProps {
  runId: number
  isRunning: boolean
  refreshIntervalMs?: number
  refreshGeneration?: number
}

type MetricKind = 'cpu' | 'mem'

function seriesKey(server: string, kind: MetricKind): string {
  return `${server}__${kind}`
}

function seriesLabel(server: string, kind: MetricKind): string {
  return `${server} ${kind === 'cpu' ? 'CPU' : 'Mem'}`
}

function avg(values: number[]): number | null {
  if (!values.length) return null
  const sum = values.reduce((a, b) => a + b, 0)
  return Math.round((sum / values.length) * 10) / 10
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

  const averages = useMemo(() => {
    const samples = resources?.samples ?? []
    const rows = serverNames.map((name) => {
      const cpuVals: number[] = []
      const memVals: number[] = []
      for (const s of samples) {
        const m = s.servers?.[name]
        if (m?.cpu_percent != null && Number.isFinite(m.cpu_percent)) cpuVals.push(m.cpu_percent)
        if (m?.memory_percent != null && Number.isFinite(m.memory_percent)) {
          memVals.push(m.memory_percent)
        }
      }
      return {
        name,
        cpuAvg: avg(cpuVals),
        memAvg: avg(memVals),
        sampleCount: Math.max(cpuVals.length, memVals.length),
      }
    })
    const allCpu = rows.flatMap((r) => (r.cpuAvg != null ? [r.cpuAvg] : []))
    const allMem = rows.flatMap((r) => (r.memAvg != null ? [r.memAvg] : []))
    // Prefer point-weighted totals across all raw samples.
    const cpuAll: number[] = []
    const memAll: number[] = []
    for (const s of samples) {
      for (const name of serverNames) {
        const m = s.servers?.[name]
        if (m?.cpu_percent != null && Number.isFinite(m.cpu_percent)) cpuAll.push(m.cpu_percent)
        if (m?.memory_percent != null && Number.isFinite(m.memory_percent)) {
          memAll.push(m.memory_percent)
        }
      }
    }
    const durationSec =
      samples.length >= 2
        ? Math.max(0, Number(samples[samples.length - 1]?.t ?? 0) - Number(samples[0]?.t ?? 0))
        : samples.length === 1
          ? Number(samples[0]?.t ?? 0)
          : 0
    return {
      rows,
      totalCpu: avg(cpuAll.length ? cpuAll : allCpu),
      totalMem: avg(memAll.length ? memAll : allMem),
      durationSec,
      samplePoints: samples.length,
    }
  }, [resources, serverNames])

  const latest = resources?.samples?.[resources.samples.length - 1]
  const hasData = chartData.length > 0 && serverNames.length > 0
  const hasTargets = (resources?.targets?.length ?? 0) > 0 || serverNames.length > 0

  const metaParts: string[] = []
  if (latest) {
    for (const name of serverNames) {
      const m = latest.servers?.[name]
      if (!m) continue
      const cpu = m.cpu_percent != null ? `${m.cpu_percent}%` : '—'
      const mem = m.memory_percent != null ? `${m.memory_percent}%` : '—'
      metaParts.push(`${name}: CPU ${cpu} · Mem ${mem}`)
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
      for (const kind of ['cpu', 'mem'] as MetricKind[]) {
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
    !isHidden(seriesKey(server, 'cpu')) && !isHidden(seriesKey(server, 'mem'))

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
                CPU
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
              Average over available duration
              {averages.durationSec > 0 ? ` (${formatDuration(averages.durationSec)})` : ''}
              {averages.samplePoints ? ` · ${averages.samplePoints} sample(s)` : ''}
            </h3>
            <table className="data-table azure-avg-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Avg CPU %</th>
                  <th>Avg Memory %</th>
                  <th>Samples</th>
                </tr>
              </thead>
              <tbody>
                {averages.rows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.cpuAvg != null ? row.cpuAvg.toFixed(1) : '—'}</td>
                    <td>{row.memAvg != null ? row.memAvg.toFixed(1) : '—'}</td>
                    <td>{row.sampleCount || '—'}</td>
                  </tr>
                ))}
                <tr className="azure-avg-total">
                  <td>
                    <strong>Total Avg</strong>
                  </td>
                  <td>
                    <strong>{averages.totalCpu != null ? averages.totalCpu.toFixed(1) : '—'}</strong>
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

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

function AzureResourceChart({
  runId,
  isRunning,
  refreshIntervalMs,
  refreshGeneration,
}: AzureResourceChartProps) {
  const [resources, setResources] = useState<AzureResources | null>(null)

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

  const chartData = useMemo(() => {
    const rows = (resources?.samples ?? []).map((s) => {
      const row: Record<string, number | null> = { t: s.t }
      for (const name of serverNames) {
        const m = s.servers?.[name]
        row[`${name}__cpu`] = m?.cpu_percent ?? null
        row[`${name}__mem`] = m?.memory_percent ?? null
      }
      return row
    })
    return downsamplePoints(rows as { t: number }[])
  }, [resources, serverNames])

  const timeline = useMemo(
    () => timelineScaleForSeconds(maxTimeFromPoints(chartData)),
    [chartData]
  )

  const latest = resources?.samples?.[resources.samples.length - 1]
  const hasData = chartData.length > 0 && serverNames.length > 0

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

  return (
    <DashboardSection
      title="Azure Target Servers (CPU / Memory)"
      meta={metaParts.length ? metaParts.join(' · ') : undefined}
      defaultExpanded={hasData}
    >
      {hasData ? (
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                domain={timeline.domain}
                ticks={timeline.ticks}
                tickFormatter={timeline.tickFormatter}
                stroke={chartTheme.axis}
              />
              <YAxis domain={[0, 100]} unit="%" stroke={chartTheme.axis} width={42} />
              <Tooltip
                labelFormatter={(v) => timeline.tickFormatter(Number(v))}
                formatter={(value: number | null, name: string) => [
                  value == null ? '—' : `${value}%`,
                  name,
                ]}
              />
              <Legend />
              {serverNames.map((name, i) => (
                <Line
                  key={`${name}-cpu`}
                  type="monotone"
                  dataKey={`${name}__cpu`}
                  name={`${name} CPU`}
                  stroke={COLORS[i % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
              {serverNames.map((name, i) => (
                <Line
                  key={`${name}-mem`}
                  type="monotone"
                  dataKey={`${name}__mem`}
                  name={`${name} Mem`}
                  stroke={COLORS[i % COLORS.length]}
                  strokeDasharray="4 3"
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="empty">
          {isRunning
            ? 'Collecting Azure CPU/Memory samples… (enable Azure Monitor in Configuration)'
            : 'No Azure server metrics stored for this run'}
        </p>
      )}
    </DashboardSection>
  )
}

export default memo(AzureResourceChart)

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type { HostResources } from '../types'
import { maxTimeFromPoints, timelineScaleForSeconds } from '../utils/timeline'
import { chartTheme } from '../utils/chartTheme'

const RESOURCE_POLL_MS = 20_000

interface HostResourceChartProps {
  runId: number
  isRunning: boolean
}

export default function HostResourceChart({ runId, isRunning }: HostResourceChartProps) {
  const [resources, setResources] = useState<HostResources | null>(null)

  const loadResources = useCallback(async () => {
    try {
      const data = await api.getRunResources(runId)
      setResources(data)
    } catch {
      /* run folder may not exist yet */
    }
  }, [runId])

  useEffect(() => {
    void loadResources()
    const interval = setInterval(() => void loadResources(), RESOURCE_POLL_MS)
    return () => clearInterval(interval)
  }, [loadResources, isRunning])

  const chartData = useMemo(
    () =>
      (resources?.samples ?? []).map((s) => ({
        t: s.t,
        cpu_percent: s.cpu_percent,
        memory_percent: s.memory_percent,
      })),
    [resources]
  )

  const timeline = useMemo(
    () => timelineScaleForSeconds(maxTimeFromPoints(chartData)),
    [chartData]
  )

  const latest = resources?.samples?.[resources.samples.length - 1]

  return (
    <div className="card">
      <h2>Host System Resources</h2>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
        CPU and memory sampled every {resources?.interval_seconds ?? 20}s on the test server
        {isRunning ? ' · updates live' : ' · recorded during run'}
      </p>

      {latest && (
        <div className="resource-summary">
          <span>Latest CPU: <strong>{latest.cpu_percent}%</strong></span>
          <span>Latest memory: <strong>{latest.memory_percent}%</strong></span>
          <span>
            {latest.memory_used_mb.toLocaleString()} / {latest.memory_total_mb.toLocaleString()} MB
          </span>
        </div>
      )}

      <div className="chart-wrap">
        {chartData.length > 0 ? (
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="t"
                type="number"
                stroke={chartTheme.axis}
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => timeline.formatValue(Number(t))}
                label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
              />
              <YAxis
                yAxisId="left"
                stroke={chartTheme.cpu}
                domain={[0, 100]}
                unit="%"
                label={{ value: 'CPU %', angle: -90, position: 'insideLeft' }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke={chartTheme.memory}
                domain={[0, 100]}
                unit="%"
                label={{ value: 'Memory %', angle: 90, position: 'insideRight' }}
              />
              <Tooltip
                contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}` }}
                labelFormatter={(label) => timeline.formatWithUnit(Number(label))}
                formatter={(value: number, name: string) => [`${value}%`, name]}
              />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="cpu_percent"
                name="CPU %"
                stroke={chartTheme.cpu}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="memory_percent"
                name="Memory %"
                stroke={chartTheme.memory}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="empty">
            {isRunning ? 'Collecting host resource samples…' : 'No host resource data for this run'}
          </p>
        )}
      </div>
    </div>
  )
}

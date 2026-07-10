import { memo, useMemo } from 'react'
import {
  LineChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { downsamplePoints, downsampleSeries } from '../../utils/chartDownsample'
import { maxTimeFromPoints, timelineScaleForSeconds } from '../../utils/timeline'
import { chartTheme } from '../../utils/chartTheme'

type UsersPoint = { t: number; users: number }
type ThroughputPoint = { t: number; hits_per_sec: number }
type GraphSeries = { label: string; points: { t: number; avg_ms: number }[] }
type ErrorGraphSeries = { label: string; points: { t: number; errors: number }[] }

function useTimelineScale(points: { t: number }[], elapsedSeconds?: number, capToData?: boolean) {
  return useMemo(() => {
    const dataMax = maxTimeFromPoints(points)
    const maxT = capToData ? dataMax : Math.max(dataMax, elapsedSeconds ?? 0)
    return timelineScaleForSeconds(maxT)
  }, [points, elapsedSeconds, capToData])
}

interface ActiveUsersChartProps {
  data: UsersPoint[]
  elapsedSeconds?: number
  capTimelineToData?: boolean
  refreshIntervalSeconds: number
}

export const ActiveUsersChart = memo(function ActiveUsersChart({
  data,
  elapsedSeconds,
  capTimelineToData = false,
  refreshIntervalSeconds,
}: ActiveUsersChartProps) {
  const chartData = useMemo(() => downsamplePoints(data), [data])
  const timeline = useTimelineScale(chartData, elapsedSeconds, capTimelineToData)
  const xMax = capTimelineToData
    ? maxTimeFromPoints(chartData)
    : (elapsedSeconds && elapsedSeconds > 0 ? elapsedSeconds : 'dataMax')

  return (
    <div className="card">
      <h2>Active Users</h2>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
        Virtual users over time (1s intervals) · refreshes every {refreshIntervalSeconds}s
      </p>
      <div className="chart-wrap">
        {chartData.length > 0 ? (
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="t"
                type="number"
                domain={[0, xMax || 'dataMax']}
                stroke={chartTheme.axis}
                tickFormatter={(t) => timeline.formatValue(Number(t))}
                label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
              />
              <YAxis
                stroke={chartTheme.axis}
                allowDecimals={false}
                label={{ value: 'Users', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip
                contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}` }}
                labelFormatter={(label) => timeline.formatWithUnit(Number(label))}
                formatter={(value: number) => [value, 'Active Users']}
              />
              <Area
                type="stepAfter"
                dataKey="users"
                stroke="none"
                fill={chartTheme.users}
                fillOpacity={0.12}
                isAnimationActive={false}
              />
              <Line
                type="stepAfter"
                dataKey="users"
                stroke={chartTheme.users}
                strokeWidth={2}
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
  )
})

interface ThroughputChartProps {
  data: ThroughputPoint[]
  elapsedSeconds?: number
  capTimelineToData?: boolean
  refreshIntervalSeconds: number
}

export const ThroughputChart = memo(function ThroughputChart({
  data,
  elapsedSeconds,
  capTimelineToData = false,
  refreshIntervalSeconds,
}: ThroughputChartProps) {
  const chartData = useMemo(() => downsamplePoints(data), [data])
  const timeline = useTimelineScale(chartData, elapsedSeconds, capTimelineToData)
  const xMax = capTimelineToData
    ? maxTimeFromPoints(chartData)
    : (elapsedSeconds && elapsedSeconds > 0 ? elapsedSeconds : 'dataMax')

  return (
    <div className="card">
      <h2>Throughput (Hits/s)</h2>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
        Successful hits per second · refreshes every {refreshIntervalSeconds}s
      </p>
      <div className="chart-wrap">
        {chartData.length > 0 ? (
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="t"
                type="number"
                domain={[0, xMax || 'dataMax']}
                stroke={chartTheme.axis}
                tickFormatter={(t) => timeline.formatValue(Number(t))}
                label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
              />
              <YAxis
                stroke={chartTheme.axis}
                allowDecimals
                label={{ value: 'Hits/s', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip
                contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}` }}
                labelFormatter={(label) => timeline.formatWithUnit(Number(label))}
                formatter={(value: number) => [`${value}`, 'Hits/s']}
              />
              <Area
                type="monotone"
                dataKey="hits_per_sec"
                stroke="none"
                fill={chartTheme.throughput}
                fillOpacity={0.12}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="hits_per_sec"
                stroke={chartTheme.throughput}
                strokeWidth={2}
                dot={false}
                name="Hits/s"
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="empty">Waiting for data…</p>
        )}
      </div>
    </div>
  )
})

interface ResponseTimeChartProps {
  graphData: GraphSeries[]
  graphMode: 'individual' | 'cumulative'
  selectedLabels: Set<string>
  refreshIntervalSeconds: number
  onSelectAll: () => void
  onClearSelection: () => void
  onGraphSelected: () => void
  onCumulativeGraph: () => void
}

export const ResponseTimeChart = memo(function ResponseTimeChart({
  graphData,
  graphMode,
  selectedLabels,
  refreshIntervalSeconds,
  onSelectAll,
  onClearSelection,
  onGraphSelected,
  onCumulativeGraph,
}: ResponseTimeChartProps) {
  const series = useMemo(() => downsampleSeries(graphData), [graphData])
  const timeline = useMemo(() => {
    const points = series.flatMap((s) => s.points)
    return timelineScaleForSeconds(maxTimeFromPoints(points))
  }, [series])

  return (
    <div className="card">
      <h2>Transaction Response Time</h2>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
        {graphMode === 'cumulative'
          ? `Cumulative response time · refreshes every ${refreshIntervalSeconds}s`
          : `Refreshes every ${refreshIntervalSeconds}s when transactions are selected`}
      </p>
      <div className="toolbar">
        <button type="button" className="btn btn-secondary" onClick={onSelectAll}>Select All</button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClearSelection}
          disabled={selectedLabels.size === 0}
        >
          Clear Selection
        </button>
        <button type="button" className="btn" onClick={onGraphSelected} disabled={selectedLabels.size === 0}>
          Graph Selected
        </button>
        <button type="button" className="btn" onClick={onCumulativeGraph}>Cumulative Graph</button>
      </div>
      <div className="chart-wrap">
        {series.length > 0 ? (
          <ResponsiveContainer>
            <LineChart>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="t"
                type="number"
                stroke={chartTheme.axis}
                tickFormatter={(t) => timeline.formatValue(Number(t))}
                label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
              />
              <YAxis stroke={chartTheme.axis} unit=" ms" />
              <Tooltip
                contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}` }}
                labelFormatter={(label) => timeline.formatWithUnit(Number(label))}
              />
              <Legend />
              {series.map((s, i) => (
                <Line
                  key={s.label}
                  data={s.points}
                  type="monotone"
                  dataKey="avg_ms"
                  name={s.label}
                  stroke={chartTheme.series[i % chartTheme.series.length]}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="empty">
            {graphMode === 'cumulative'
              ? 'Waiting for response time data…'
              : 'Select transaction(s) to view response time graph'}
          </p>
        )}
      </div>
      {graphMode === 'individual' && selectedLabels.size > 0 && (
        <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
          Showing individual timeline for: {Array.from(selectedLabels).join(', ')}
        </p>
      )}
    </div>
  )
})

interface ErrorsOverTimeChartProps {
  errorsGraphData: ErrorGraphSeries[]
  errorsGraphMode: 'individual' | 'all'
  selectedLabels: Set<string>
  totalErrors: number
  refreshIntervalSeconds: number
  onAllErrors: () => void
  onGraphSelectedErrors: () => void
}

export const ErrorsOverTimeChart = memo(function ErrorsOverTimeChart({
  errorsGraphData,
  errorsGraphMode,
  selectedLabels,
  totalErrors,
  refreshIntervalSeconds,
  onAllErrors,
  onGraphSelectedErrors,
}: ErrorsOverTimeChartProps) {
  const series = useMemo(() => downsampleSeries(errorsGraphData), [errorsGraphData])
  const hasPoints = series.some((s) => s.points.length > 0)
  const timeline = useMemo(() => {
    const points = series.flatMap((s) => s.points)
    return timelineScaleForSeconds(maxTimeFromPoints(points))
  }, [series])

  return (
    <div className="card">
      <h2>Errors Over Time</h2>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.25rem' }}>
        Error count per 5s interval · auto-loads on open · refreshes every {refreshIntervalSeconds}s
      </p>
      <div className="toolbar">
        <button type="button" className="btn" onClick={onAllErrors}>
          All Errors
        </button>
        <button
          type="button"
          className="btn"
          onClick={onGraphSelectedErrors}
          disabled={selectedLabels.size === 0}
        >
          Graph Selected ({selectedLabels.size})
        </button>
      </div>
      <div className="chart-wrap">
        {hasPoints ? (
          <ResponsiveContainer>
            <LineChart>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="t"
                type="number"
                stroke={chartTheme.axis}
                tickFormatter={(t) => timeline.formatValue(Number(t))}
                label={{ value: timeline.axisLabel, position: 'insideBottom', offset: -5 }}
              />
              <YAxis stroke={chartTheme.axis} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}` }}
                labelFormatter={(label) => timeline.formatWithUnit(Number(label))}
              />
              <Legend />
              {series.map((s, i) => (
                <Line
                  key={s.label}
                  data={s.points}
                  type="monotone"
                  dataKey="errors"
                  name={s.label}
                  stroke={chartTheme.errorSeries[i % chartTheme.errorSeries.length]}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="empty">
            {totalErrors > 0 ? 'Loading error graph…' : 'No errors recorded yet'}
          </p>
        )}
      </div>
      {errorsGraphMode === 'individual' && selectedLabels.size > 0 && (
        <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
          Showing errors per interval for: {Array.from(selectedLabels).join(', ')}
        </p>
      )}
    </div>
  )
})

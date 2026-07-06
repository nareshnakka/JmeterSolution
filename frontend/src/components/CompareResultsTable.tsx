import { Fragment, useEffect, useMemo, useState } from 'react'
import type { CompareSummary } from '../types'

export type CompareLayoutMode = 'metric-pairs' | 'by-run'

export type MetricKey = 'avg_ms' | 'p90_ms' | 'count' | 'error_pct'

export type ColumnGroup =
  | { kind: 'metric'; metric: MetricKey }
  | { kind: 'delta_avg' }
  | { kind: 'delta_pct' }

export const METRIC_LABELS: Record<MetricKey, string> = {
  avg_ms: 'Avg (ms)',
  p90_ms: 'P90 (ms)',
  count: 'Count',
  error_pct: 'Error %',
}

export const DELTA_AVG_LABEL = 'Δ Avg (ms)'
export const DELTA_PCT_LABEL = 'Δ %'

export const DEFAULT_METRIC_GROUPS: ColumnGroup[] = [
  { kind: 'metric', metric: 'avg_ms' },
  { kind: 'metric', metric: 'p90_ms' },
  { kind: 'metric', metric: 'count' },
  { kind: 'metric', metric: 'error_pct' },
  { kind: 'delta_avg' },
  { kind: 'delta_pct' },
]

export interface RunMetrics {
  avg_ms: number | null
  p90_ms: number | null
  count: number | null
  error_pct: number | null
}

export interface CompareRow {
  label: string
  runs: RunMetrics[]
  delta: number | null
  delta_pct: number | null
}

type SortField = 'transaction' | 'avg_ms' | 'delta' | 'delta_pct'
type SortDir = 'asc' | 'desc'

interface CompareResultsTableProps {
  summaries: CompareSummary[]
  rows: CompareRow[]
  transactionFilter: string
  onTransactionFilterChange: (value: string) => void
  sortField: SortField
  sortDir: SortDir
  onSort: (field: SortField) => void
}

function formatNum(value: number | null): string {
  if (value == null) return '—'
  return String(value)
}

function formatMetricValue(m: RunMetrics, key: MetricKey): string {
  if (key === 'error_pct') return m.error_pct != null ? `${m.error_pct}%` : '—'
  if (key === 'count') return formatNum(m.count)
  return formatNum(m[key])
}

function formatDelta(value: number | null): string {
  if (value == null) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value}`
}

function formatDeltaPct(value: number | null): string {
  if (value == null) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value}%`
}

function deltaClass(value: number | null): string {
  if (value == null || value === 0) return ''
  return value > 0 ? 'compare-worse' : 'compare-better'
}

function columnGroupKey(g: ColumnGroup): string {
  if (g.kind === 'metric') return `metric:${g.metric}`
  return g.kind
}

function columnGroupLabel(g: ColumnGroup): string {
  if (g.kind === 'metric') return METRIC_LABELS[g.metric]
  if (g.kind === 'delta_avg') return DELTA_AVG_LABEL
  return DELTA_PCT_LABEL
}

function isDeltaGroup(g: ColumnGroup): boolean {
  return g.kind === 'delta_avg' || g.kind === 'delta_pct'
}

function moveItem<T>(items: T[], index: number, dir: -1 | 1): T[] {
  const next = [...items]
  const j = index + dir
  if (j < 0 || j >= next.length) return items
  ;[next[index], next[j]] = [next[j], next[index]]
  return next
}

function SortableHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  className = '',
  rowSpan,
  colSpan,
}: {
  field: SortField
  label: string
  sortField: SortField
  sortDir: SortDir
  onSort: (field: SortField) => void
  className?: string
  rowSpan?: number
  colSpan?: number
}) {
  const active = sortField === field
  return (
    <th
      className={`compare-sortable ${className}`.trim()}
      onClick={() => onSort(field)}
      title="Click to sort"
      rowSpan={rowSpan}
      colSpan={colSpan}
    >
      {label}
      <span className="compare-sort-indicator">{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )
}

export default function CompareResultsTable({
  summaries,
  rows,
  transactionFilter,
  onTransactionFilterChange,
  sortField,
  sortDir,
  onSort,
}: CompareResultsTableProps) {
  const showDelta = summaries.length >= 2
  const [layoutMode, setLayoutMode] = useState<CompareLayoutMode>('metric-pairs')
  const [columnGroups, setColumnGroups] = useState<ColumnGroup[]>(DEFAULT_METRIC_GROUPS)
  const [runOrder, setRunOrder] = useState<number[]>([])
  const [metricOrder, setMetricOrder] = useState<MetricKey[]>(['avg_ms', 'p90_ms', 'count', 'error_pct'])

  useEffect(() => {
    setRunOrder(summaries.map((s) => s.test_run_id))
  }, [summaries])

  useEffect(() => {
    setColumnGroups((prev) => {
      const normalized = prev.flatMap((g): ColumnGroup[] => {
        if ((g as { kind: string }).kind === 'delta') {
          return [{ kind: 'delta_avg' }, { kind: 'delta_pct' }]
        }
        return [g]
      })
      return normalized.length ? normalized : DEFAULT_METRIC_GROUPS
    })
  }, [summaries])

  const visibleGroups = useMemo(
    () => columnGroups.filter((g) => !isDeltaGroup(g) || showDelta),
    [columnGroups, showDelta]
  )

  const summaryById = useMemo(
    () => new Map(summaries.map((s) => [s.test_run_id, s])),
    [summaries]
  )

  const orderedSummaries = useMemo(
    () => runOrder.map((id) => summaryById.get(id)).filter(Boolean) as CompareSummary[],
    [runOrder, summaryById]
  )

  const deltaCaption =
    orderedSummaries.length >= 2
      ? `#${orderedSummaries[1]?.test_run_id} vs #${orderedSummaries[0]?.test_run_id}`
      : ''

  function moveGroup(index: number, dir: -1 | 1) {
    setColumnGroups((prev) => moveItem(prev, index, dir))
  }

  function moveRun(index: number, dir: -1 | 1) {
    setRunOrder((prev) => moveItem(prev, index, dir))
  }

  function moveMetric(index: number, dir: -1 | 1) {
    setMetricOrder((prev) => moveItem(prev, index, dir))
  }

  function resetLayout() {
    setLayoutMode('metric-pairs')
    setColumnGroups(DEFAULT_METRIC_GROUPS)
    setMetricOrder(['avg_ms', 'p90_ms', 'count', 'error_pct'])
    setRunOrder(summaries.map((s) => s.test_run_id))
  }

  function renderMetricPairCells(row: CompareRow, metric: MetricKey) {
    return orderedSummaries.map((s, i) => {
      const runIdx = summaries.findIndex((x) => x.test_run_id === s.test_run_id)
      const m = row.runs[runIdx] ?? row.runs[i]
      return (
        <td key={`${row.label}-${metric}-${s.test_run_id}`} className="num">
          {formatMetricValue(m, metric)}
        </td>
      )
    })
  }

  function renderDeltaCell(row: CompareRow, group: ColumnGroup) {
    if (!showDelta || !isDeltaGroup(group)) return null
    if (group.kind === 'delta_avg') {
      return (
        <td className={`num ${deltaClass(row.delta)}`}>{formatDelta(row.delta)}</td>
      )
    }
    return (
      <td className={`num ${deltaClass(row.delta_pct)}`}>{formatDeltaPct(row.delta_pct)}</td>
    )
  }

  function renderDeltaHeader(group: ColumnGroup) {
    if (group.kind === 'delta_avg') {
      return (
        <SortableHeader
          key="delta_avg"
          field="delta"
          label={DELTA_AVG_LABEL}
          sortField={sortField}
          sortDir={sortDir}
          onSort={onSort}
          rowSpan={2}
          className="compare-metric-group num"
        />
      )
    }
    return (
      <SortableHeader
        key="delta_pct"
        field="delta_pct"
        label={DELTA_PCT_LABEL}
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
        rowSpan={2}
        className="compare-metric-group num"
      />
    )
  }

  function filterPlaceholderCount(): number {
    if (layoutMode === 'metric-pairs') {
      return visibleGroups.reduce((n, g) => {
        if (g.kind === 'metric') return n + orderedSummaries.length
        return n + 1
      }, 0)
    }
    return orderedSummaries.length * metricOrder.length + (showDelta ? 2 : 0)
  }

  return (
    <>
      <div className="compare-layout-toolbar">
        <label className="compare-layout-label">
          Layout
          <select
            className="table-filter-input"
            value={layoutMode}
            onChange={(e) => setLayoutMode(e.target.value as CompareLayoutMode)}
          >
            <option value="metric-pairs">Metric pairs (Avg | Avg, P90 | P90…)</option>
            <option value="by-run">Group by test run</option>
          </select>
        </label>
        <button type="button" className="btn btn-secondary" onClick={resetLayout}>
          Reset columns
        </button>
        {showDelta && deltaCaption && (
          <span className="compare-delta-note">Delta columns: {deltaCaption}</span>
        )}
      </div>

      {layoutMode === 'metric-pairs' ? (
        <div className="compare-column-order">
          <span className="compare-column-order-label">Column order:</span>
          {visibleGroups.map((g) => {
            const groupIndex = columnGroups.findIndex((c) => columnGroupKey(c) === columnGroupKey(g))
            return (
              <span key={columnGroupKey(g)} className="compare-column-chip">
                {columnGroupLabel(g)}
                <button type="button" className="compare-col-move" onClick={() => moveGroup(groupIndex, -1)} title="Move left" aria-label="Move left">←</button>
                <button type="button" className="compare-col-move" onClick={() => moveGroup(groupIndex, 1)} title="Move right" aria-label="Move right">→</button>
              </span>
            )
          })}
        </div>
      ) : (
        <div className="compare-column-order">
          <span className="compare-column-order-label">Test run order:</span>
          {orderedSummaries.map((s, i) => (
            <span key={s.test_run_id} className="compare-column-chip">
              Run #{s.test_run_id}
              <button type="button" className="compare-col-move" onClick={() => moveRun(i, -1)} title="Move left" aria-label="Move left">←</button>
              <button type="button" className="compare-col-move" onClick={() => moveRun(i, 1)} title="Move right" aria-label="Move right">→</button>
            </span>
          ))}
          <span className="compare-column-order-label" style={{ marginLeft: '0.75rem' }}>Metrics:</span>
          {metricOrder.map((m, i) => (
            <span key={m} className="compare-column-chip">
              {METRIC_LABELS[m]}
              <button type="button" className="compare-col-move" onClick={() => moveMetric(i, -1)} title="Move left" aria-label="Move left">←</button>
              <button type="button" className="compare-col-move" onClick={() => moveMetric(i, 1)} title="Move right" aria-label="Move right">→</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="compare-table table-with-filters">
          <thead>
            {layoutMode === 'metric-pairs' ? (
              <>
                <tr>
                  <SortableHeader
                    field="transaction"
                    label="Transaction"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={onSort}
                    rowSpan={2}
                  />
                  {visibleGroups.map((g) =>
                    g.kind === 'metric' ? (
                      <th key={g.metric} colSpan={orderedSummaries.length} className="compare-metric-group">
                        {METRIC_LABELS[g.metric]}
                      </th>
                    ) : (
                      renderDeltaHeader(g)
                    )
                  )}
                </tr>
                <tr>
                  {visibleGroups.map((g) =>
                    g.kind === 'metric'
                      ? orderedSummaries.map((s) => (
                          <th key={`${g.metric}-${s.test_run_id}`} className="num compare-run-id-header">
                            #{s.test_run_id}
                          </th>
                        ))
                      : null
                  )}
                </tr>
              </>
            ) : (
              <>
                <tr>
                  <SortableHeader
                    field="transaction"
                    label="Transaction"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={onSort}
                    rowSpan={2}
                  />
                  {orderedSummaries.map((s) => (
                    <th key={s.test_run_id} colSpan={metricOrder.length} className="compare-run-group">
                      Run #{s.test_run_id}
                      <br />
                      <small>{s.release_name} / {s.build_name}</small>
                    </th>
                  ))}
                  {showDelta && (
                    <>
                      <SortableHeader
                        field="delta"
                        label={DELTA_AVG_LABEL}
                        sortField={sortField}
                        sortDir={sortDir}
                        onSort={onSort}
                        rowSpan={2}
                        className="compare-metric-group num"
                      />
                      <SortableHeader
                        field="delta_pct"
                        label={DELTA_PCT_LABEL}
                        sortField={sortField}
                        sortDir={sortDir}
                        onSort={onSort}
                        rowSpan={2}
                        className="compare-metric-group num"
                      />
                    </>
                  )}
                </tr>
                <tr>
                  {orderedSummaries.map((s) =>
                    metricOrder.map((m) => (
                      <th key={`${s.test_run_id}-${m}`} className="num">
                        {METRIC_LABELS[m]}
                      </th>
                    ))
                  )}
                </tr>
              </>
            )}
            <tr className="table-filter-row">
              <th>
                <input
                  className="table-filter-input"
                  placeholder="Filter transaction…"
                  value={transactionFilter}
                  onChange={(e) => onTransactionFilterChange(e.target.value)}
                />
              </th>
              {Array.from({ length: filterPlaceholderCount() }).map((_, i) => (
                <th key={i} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {layoutMode === 'metric-pairs' ? (
                  visibleGroups.map((g) =>
                    g.kind === 'metric' ? (
                      <Fragment key={g.metric}>{renderMetricPairCells(row, g.metric)}</Fragment>
                    ) : (
                      <Fragment key={columnGroupKey(g)}>{renderDeltaCell(row, g)}</Fragment>
                    )
                  )
                ) : (
                  <>
                    {orderedSummaries.map((s) => {
                      const runIdx = summaries.findIndex((x) => x.test_run_id === s.test_run_id)
                      const m = row.runs[runIdx]
                      return (
                        <Fragment key={s.test_run_id}>
                          {metricOrder.map((metric) => (
                            <td key={`${row.label}-${s.test_run_id}-${metric}`} className="num">
                              {formatMetricValue(m, metric)}
                            </td>
                          ))}
                        </Fragment>
                      )
                    })}
                    {showDelta && (
                      <>
                        {renderDeltaCell(row, { kind: 'delta_avg' })}
                        {renderDeltaCell(row, { kind: 'delta_pct' })}
                      </>
                    )}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

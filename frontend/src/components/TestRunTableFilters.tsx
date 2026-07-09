import type { TestRunColumnFilters } from '../utils/testRunFilters'

const RUN_TYPES = [
  { value: '', label: 'Any type' },
  { value: 'adhoc', label: 'Adhoc' },
  { value: 'scheduled', label: 'Scheduled' },
]

const RUN_STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'pending', label: 'Pending' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

interface TestRunTableFiltersProps {
  filters: TestRunColumnFilters
  onChange: (next: TestRunColumnFilters) => void
  showApplication?: boolean
  showFinished?: boolean
  showScheduled?: boolean
  showStarted?: boolean
  showRunType?: boolean
  showConsiderForRelease?: boolean
  showActionsColumn?: boolean
  onClear?: () => void
  hasActiveFilters?: boolean
}

export default function TestRunTableFilters({
  filters,
  onChange,
  showApplication = true,
  showFinished = false,
  showScheduled = true,
  showStarted = true,
  showRunType = true,
  showConsiderForRelease = false,
  showActionsColumn = false,
  onClear,
  hasActiveFilters = false,
}: TestRunTableFiltersProps) {
  function set<K extends keyof TestRunColumnFilters>(key: K, value: TestRunColumnFilters[K]) {
    onChange({ ...filters, [key]: value })
  }

  return (
    <tr className="table-filter-row">
      <th />
      <th>
        <input
          className="table-filter-input"
          placeholder="Filter…"
          value={filters.id}
          onChange={(e) => set('id', e.target.value)}
        />
      </th>
      <th>
        <input
          className="table-filter-input"
          placeholder="Filter…"
          value={filters.release}
          onChange={(e) => set('release', e.target.value)}
        />
      </th>
      <th>
        <input
          className="table-filter-input"
          placeholder="Filter…"
          value={filters.build}
          onChange={(e) => set('build', e.target.value)}
        />
      </th>
      {showApplication && (
        <th>
          <input
            className="table-filter-input"
            placeholder="Filter…"
            value={filters.application}
            onChange={(e) => set('application', e.target.value)}
          />
        </th>
      )}
      <th>
        <input
          className="table-filter-input"
          placeholder="Filter…"
          value={filters.scenario}
          onChange={(e) => set('scenario', e.target.value)}
        />
      </th>
      <th>
        <input
          className="table-filter-input"
          placeholder="Filter…"
          value={filters.tags}
          onChange={(e) => set('tags', e.target.value)}
        />
      </th>
      {showRunType && (
        <th>
          <select
            className="table-filter-input"
            value={filters.runType}
            onChange={(e) => set('runType', e.target.value)}
          >
            {RUN_TYPES.map((s) => (
              <option key={s.value || 'any'} value={s.value}>{s.label}</option>
            ))}
          </select>
        </th>
      )}
      <th>
        <select
          className="table-filter-input"
          value={filters.status}
          onChange={(e) => set('status', e.target.value)}
        >
          {RUN_STATUSES.map((s) => (
            <option key={s.value || 'any'} value={s.value}>{s.label}</option>
          ))}
        </select>
      </th>
      {showConsiderForRelease && (
        <th>
          <select
            className="table-filter-input"
            value={filters.considerForRelease}
            onChange={(e) => set('considerForRelease', e.target.value)}
          >
            <option value="">Any</option>
            <option value="yes">Marked</option>
            <option value="no">Not marked</option>
          </select>
        </th>
      )}
      {showScheduled && (
        <th>
          <div className="table-filter-stack">
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Scheduled from"
              value={filters.scheduledFrom}
              onChange={(e) => set('scheduledFrom', e.target.value)}
            />
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Scheduled to"
              value={filters.scheduledTo}
              onChange={(e) => set('scheduledTo', e.target.value)}
            />
          </div>
        </th>
      )}
      {showStarted && (
        <th>
          <div className="table-filter-stack">
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Started from"
              value={filters.startedFrom}
              onChange={(e) => set('startedFrom', e.target.value)}
            />
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Started to"
              value={filters.startedTo}
              onChange={(e) => set('startedTo', e.target.value)}
            />
          </div>
        </th>
      )}
      {showFinished && (
        <th>
          <div className="table-filter-stack">
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Finished from"
              value={filters.finishedFrom}
              onChange={(e) => set('finishedFrom', e.target.value)}
            />
            <input
              className="table-filter-input"
              type="datetime-local"
              title="Finished to"
              value={filters.finishedTo}
              onChange={(e) => set('finishedTo', e.target.value)}
            />
          </div>
        </th>
      )}
      {(showActionsColumn || onClear) && (
        <th>
          {hasActiveFilters && onClear && (
            <button type="button" className="btn btn-secondary table-filter-clear" onClick={onClear}>
              Clear
            </button>
          )}
        </th>
      )}
    </tr>
  )
}

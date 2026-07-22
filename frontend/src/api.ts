const BASE = '/api'
/** Large finished JTLs can take minutes to parse once; aborting early causes "connection timeout". */
const REQUEST_TIMEOUT_MS = 180_000

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const outerSignal = init?.signal
  const onOuterAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal })
    const text = await res.text()

    if (!res.ok) {
      try {
        const json = JSON.parse(text) as { detail?: string | { msg: string }[] }
        if (typeof json.detail === 'string') throw new Error(json.detail)
        if (Array.isArray(json.detail)) throw new Error(json.detail.map((d) => d.msg).join(', '))
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e
      }
      throw new Error(text.trim() || res.statusText)
    }

    if (res.status === 204 || !text) return undefined as T

    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('Invalid response from server')
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(
        'Request timed out while building the report. The server may still be busy — wait a moment and retry.'
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

export const api = {
  health: () => request<{ status: string; jmeter_found: boolean }>('/health'),

  listReleases: () => request<import('./types').Release[]>('/releases'),
  createRelease: (name: string, description?: string) =>
    request<import('./types').Release>('/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    }),

  listBuilds: (releaseId: number) =>
    request<import('./types').Build[]>(`/releases/${releaseId}/builds`),
  createBuild: (releaseId: number, name: string, description?: string) =>
    request<import('./types').Build>(`/releases/${releaseId}/builds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    }),

  listApplications: (buildId: number) =>
    request<import('./types').Application[]>(`/builds/${buildId}/applications`),
  createApplication: (buildId: number, name: string, appType?: string) =>
    request<import('./types').Application>(`/builds/${buildId}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, app_type: appType }),
    }),

  listScenarios: (appId: number) =>
    request<import('./types').Scenario[]>(`/applications/${appId}/scenarios`),
  listAllScenarios: (filters: {
    release?: string
    build?: string
    application?: string
    name?: string
    tag?: string
    run_from?: string
    run_to?: string
    last_run_status?: string
  } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => {
      if (v) params.set(k, v)
    })
    const qs = params.toString()
    return request<import('./types').ScenarioListItem[]>(`/scenarios${qs ? `?${qs}` : ''}`)
  },
  stopScenario: (scenarioId: number) =>
    request<{ ok: boolean; test_run_id: number }>(`/scenarios/${scenarioId}/stop`, { method: 'POST' }),
  getScenario: (scenarioId: number) =>
    request<import('./types').Scenario>(`/scenarios/${scenarioId}`),
  cloneScenario: (scenarioId: number) =>
    request<import('./types').Scenario>(`/scenarios/${scenarioId}/clone`, { method: 'POST' }),
  getScenarioSchedule: (scenarioId: number) =>
    request<import('./types').ScenarioSchedule | null>(`/scenarios/${scenarioId}/schedule`),
  createScenarioSchedule: (
    scenarioId: number,
    body: {
      frequency: 'once' | 'daily' | 'weekly'
      run_at: string
      days_of_week?: number[]
      notes?: string
    }
  ) =>
    request<import('./types').ScenarioSchedule>(`/scenarios/${scenarioId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  cancelScenarioSchedule: (scenarioId: number) =>
    request<{ ok: boolean }>(`/scenarios/${scenarioId}/schedule`, { method: 'DELETE' }),
  updateScenario: (scenarioId: number, form: FormData) =>
    request<import('./types').Scenario>(`/scenarios/${scenarioId}/update`, { method: 'POST', body: form }),
  listScenarioFiles: (scenarioId: number) =>
    request<import('./types').ScenarioFile[]>(`/scenarios/${scenarioId}/files`),
  deleteScenarioFile: (scenarioId: number, fileId: number) =>
    request<void>(`/scenarios/${scenarioId}/files/${fileId}`, { method: 'DELETE' }),
  createScenario: (appId: number, form: FormData) =>
    request<import('./types').Scenario>(`/applications/${appId}/scenarios`, {
      method: 'POST',
      body: form,
    }),
  uploadScenarioFiles: (scenarioId: number, files: File[], kind: 'dependency' | 'upload' = 'dependency') => {
    const form = new FormData()
    form.append('kind', kind)
    files.forEach((f) => form.append('files', f))
    return request<import('./types').ScenarioFile[]>(`/scenarios/${scenarioId}/files`, { method: 'POST', body: form })
  },

  listTestRuns: () => request<import('./types').TestRun[]>('/test-runs'),
  getTestRunQueue: () => request<import('./types').TestRunQueue>('/test-runs/queue'),
  getTestRunActivity: () =>
    request<import('./types').TestRunActivity>('/test-runs/activity'),
  getNotifications: () => request<import('./types').AppNotification[]>('/notifications'),
  clearNotifications: (ids?: number[]) =>
    request<{ deleted: number }>('/notifications/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids ?? null }),
    }),
  getUpdateStatus: () => request<import('./types').UpdateCheck>('/updates/status'),
  checkForUpdates: () => request<import('./types').UpdateCheck>('/updates/check'),
  applyUpdate: (version?: string) =>
    request<{ status: string; message: string }>('/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, version: version ?? null }),
    }),
  deleteTestRuns: (ids: number[]) =>
    request<{ deleted: number[]; failed: { id: number; error: string }[] }>('/test-runs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_run_ids: ids }),
    }),
  deleteTestRunsByDate: (body: {
    finished_from?: string | null
    finished_to?: string | null
    include_archived?: boolean
    dry_run?: boolean
  }) =>
    request<import('./types').DeleteByDateResult>('/test-runs/delete-by-date', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  setConsiderForRelease: (ids: number[], consider: boolean) =>
    request<{ updated: number[]; failed: { id: number; error: string }[] }>(
      '/test-runs/consider-for-release',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_run_ids: ids, consider }),
      }
    ),
  getTestRun: (id: number) => request<import('./types').TestRun>(`/test-runs/${id}`),
  cancelTestRun: (runId: number) =>
    request<{ ok: boolean }>(`/test-runs/${runId}/cancel`, { method: 'POST' }),
  startTest: (scenarioId: number, notes?: string) =>
    request<import('./types').TestRun>('/test-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenarioId, notes }),
    }),
  scheduleTest: (scenarioId: number, scheduledAt: string, notes?: string) =>
    request<import('./types').TestRun>('/test-runs/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenarioId, scheduled_at: scheduledAt, notes }),
    }),
  getMetrics: (runId: number) => request<import('./types').LiveMetrics>(`/test-runs/${runId}/metrics`),
  /** Single-connection finished report (metrics + errors + default graphs). */
  getTestRunReport: (runId: number) =>
    request<import('./types').TestRunReport>(`/test-runs/${runId}/report`),
  getAggregateTotal: (runId: number, kind: string = 'all', label?: string) => {
    const params = new URLSearchParams({ kind })
    if (label?.trim()) params.set('label', label.trim())
    return request<import('./types').TransactionMetric>(
      `/test-runs/${runId}/aggregate-total?${params}`
    )
  },
  getRunResources: (runId: number) =>
    request<import('./types').HostResources>(`/test-runs/${runId}/resources`),
  getRunAzureResources: (runId: number) =>
    request<import('./types').AzureResources>(`/test-runs/${runId}/azure-resources`),
  getRunErrors: (runId: number, search?: string, limit = 200) => {
    const params = new URLSearchParams()
    if (search?.trim()) params.set('search', search.trim())
    params.set('limit', String(limit))
    return request<import('./types').ErrorSample[]>(`/test-runs/${runId}/errors?${params}`)
  },
  getRunErrorDetail: (runId: number, sampleIndex: number) =>
    request<import('./types').ErrorDetail>(`/test-runs/${runId}/errors/${sampleIndex}`),
  getLogs: (runId: number, offset = 0) =>
    request<import('./types').TestRunLogs>(`/test-runs/${runId}/logs?offset=${offset}`),
  getGraph: (runId: number, labels: string[], cumulative = false) => {
    const params = new URLSearchParams()
    labels.forEach((l) => params.append('labels', l))
    if (cumulative) params.set('cumulative', 'true')
    return request<{ mode: string; series: { label: string; points: { t: number; avg_ms: number }[] }[] }>(
      `/test-runs/${runId}/graph?${params}`
    )
  },
  getErrorsGraph: (runId: number, labels: string[]) => {
    const params = new URLSearchParams()
    labels.forEach((l) => params.append('labels', l))
    return request<{ mode: string; series: { label: string; points: { t: number; errors: number }[] }[] }>(
      `/test-runs/${runId}/errors-graph?${params}`
    )
  },
  compareRuns: (ids: number[]) =>
    request<import('./types').CompareSummary[]>('/test-runs/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_run_ids: ids }),
    }),
  downloadUrl: (runId: number, file: string) => `/api/test-runs/${runId}/download?file=${encodeURIComponent(file)}`,

  getConfig: () => request<import('./types').SystemConfig>('/config'),
  testAzureMonitor: () =>
    request<import('./types').AzureMonitorProbe>('/config/azure-monitor/test', { method: 'POST' }),
  saveConfig: (body: {
    jmeter_home: string
    data_root: string
    archive_retention_months: number
    auto_archive_enabled: boolean
    resource_sample_interval_seconds: number
    live_dashboard_refresh_interval_seconds: number
    aggregate_total_avg_title: string
    aggregate_total_avg_filter: string
    aggregate_total_avg_exclude: string
    aggregate_load_avg_title: string
    aggregate_load_avg_filter: string
    aggregate_submit_avg_title: string
    aggregate_submit_avg_filter: string
    azure_monitor_enabled?: boolean
    azure_monitor_targets?: import('./types').AzureMonitorTarget[]
    azure_monitor_sample_interval_seconds?: number
    azure_monitor_resource_group?: string
  }) =>
    request<import('./types').SystemConfig>('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  saveAggregateSummaryConfig: (body: {
    aggregate_total_avg_title: string
    aggregate_total_avg_filter: string
    aggregate_total_avg_exclude: string
    aggregate_load_avg_title: string
    aggregate_load_avg_filter: string
    aggregate_submit_avg_title: string
    aggregate_submit_avg_filter: string
  }) =>
    request<import('./types').SystemConfig>('/config/aggregate-summary', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  listArchiveRuns: (archivedOnly = false, includeArchived = true) => {
    const params = new URLSearchParams()
    if (archivedOnly) params.set('archived_only', 'true')
    if (!includeArchived) params.set('include_archived', 'false')
    const qs = params.toString()
    return request<import('./types').ArchiveRunItem[]>(`/config/archive-runs${qs ? `?${qs}` : ''}`)
  },
  archiveRuns: (ids: number[]) =>
    request<import('./types').ArchiveActionResult>('/config/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_run_ids: ids }),
    }),
  restoreRuns: (ids: number[]) =>
    request<import('./types').ArchiveActionResult>('/config/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_run_ids: ids }),
    }),
  runAutoArchive: () =>
    request<{ archived: number[]; retention_months: number }>('/config/auto-archive', { method: 'POST' }),

  getBugReportStatus: () =>
    request<{ configured: boolean; repo: string }>('/bug-reports/status'),
  submitBugReport: (form: FormData) =>
    request<{
      ok: boolean
      issue_number: number
      issue_url: string
      files_uploaded: string[]
    }>('/bug-reports', { method: 'POST', body: form }),
}

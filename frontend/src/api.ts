const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    const text = await res.text()
    try {
      const json = JSON.parse(text) as { detail?: string | { msg: string }[] }
      if (typeof json.detail === 'string') throw new Error(json.detail)
      if (Array.isArray(json.detail)) throw new Error(json.detail.map((d) => d.msg).join(', '))
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e
    }
    throw new Error(text || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json()
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
  deleteTestRuns: (ids: number[]) =>
    request<{ deleted: number[]; failed: { id: number; error: string }[] }>('/test-runs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_run_ids: ids }),
    }),
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
  getRunResources: (runId: number) =>
    request<import('./types').HostResources>(`/test-runs/${runId}/resources`),
  getRunErrors: (runId: number, search?: string, limit = 200) => {
    const params = new URLSearchParams()
    if (search?.trim()) params.set('search', search.trim())
    params.set('limit', String(limit))
    return request<import('./types').ErrorSample[]>(`/test-runs/${runId}/errors?${params}`)
  },
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
  getErrorsGraph: (runId: number, labels: string[], cumulative = false) => {
    const params = new URLSearchParams()
    labels.forEach((l) => params.append('labels', l))
    if (cumulative) params.set('cumulative', 'true')
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
  saveConfig: (body: {
    jmeter_home: string
    data_root: string
    archive_retention_months: number
    auto_archive_enabled: boolean
  }) =>
    request<import('./types').SystemConfig>('/config', {
      method: 'PUT',
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
}

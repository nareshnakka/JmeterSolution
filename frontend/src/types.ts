export interface Release {
  id: number
  name: string
  description?: string
  created_at: string
}

export interface Build {
  id: number
  release_id: number
  name: string
  description?: string
  created_at: string
}

export interface Application {
  id: number
  build_id: number
  name: string
  app_type?: string
  description?: string
  created_at: string
}

export interface JmeterProperty {
  name: string
  value: string
}

export interface Scenario {
  id: number
  application_id: number
  name: string
  tag?: string
  tags?: string[]
  jmx_filename: string
  description?: string
  jmeter_properties?: JmeterProperty[]
  created_at: string
}

export interface ScenarioListItem {
  id: number
  name: string
  tags: string[]
  jmx_filename: string
  jmeter_properties?: JmeterProperty[]
  release_id: number
  release_name: string
  build_id: number
  build_name: string
  application_id: number
  application_name: string
  application_type?: string
  created_at: string
  last_run_id?: number
  last_run_status?: string
  last_run_started_at?: string
  last_run_finished_at?: string
  active_run_id?: number
  is_running: boolean
  schedule_id?: number
  schedule_frequency?: 'once' | 'daily' | 'weekly'
  next_run_at?: string
  queued_run_id?: number
  is_queued?: boolean
}

export interface ScenarioSchedule {
  id: number
  scenario_id: number
  frequency: 'once' | 'daily' | 'weekly'
  run_at: string
  days_of_week: number[]
  next_run_at: string
  is_active: boolean
  notes?: string
  created_at: string
}

export interface ScenarioFile {
  id: number
  filename: string
  kind: 'dependency' | 'upload'
  created_at: string
}

export interface TestRun {
  id: number
  scenario_id: number
  run_type: 'adhoc' | 'scheduled'
  status: string
  scheduled_at?: string
  started_at?: string
  finished_at?: string
  run_dir?: string
  jtl_path?: string
  log_path?: string
  error_message?: string
  notes?: string
  is_archived?: boolean
  archived_at?: string
  consider_for_release?: boolean
  created_at: string
  scenario_name?: string
  release_name?: string
  build_name?: string
  application_name?: string
  scenario_tags?: string[]
}

export interface QueuedRunItem extends TestRun {
  queue_position: number
}

export interface ScheduledQueueItem {
  schedule_id?: number
  test_run_id?: number
  scenario_id: number
  scenario_name?: string
  release_id?: number
  release_name?: string
  build_id?: number
  build_name?: string
  application_id?: number
  application_name?: string
  scenario_tags?: string[]
  frequency?: 'once' | 'daily' | 'weekly'
  run_at?: string
  days_of_week: number[]
  next_run_at: string
  notes?: string
}

export interface TestRunQueue {
  running: TestRun | null
  queued: QueuedRunItem[]
  scheduled: ScheduledQueueItem[]
}

/** Lightweight probe for adaptive idle/active UI polling. */
export interface TestRunActivity {
  running: number
  pending: number
  has_active: boolean
}

export interface HostResourceSample {
  t: number
  cpu_percent: number
  memory_percent: number
  memory_used_mb: number
  memory_total_mb: number
  recorded_at?: string
}

export interface HostResources {
  interval_seconds: number
  samples: HostResourceSample[]
}

export interface AzureMonitorTarget {
  name: string
  resource_id: string
}

export interface AzureVmSample {
  cpu_percent?: number | null
  cpu_max_percent?: number | null
  memory_percent?: number | null
}

export interface AzureResourceSample {
  t: number
  recorded_at?: string
  servers: Record<string, AzureVmSample>
}

export interface AzureResources {
  interval_seconds: number
  targets: AzureMonitorTarget[]
  samples: AzureResourceSample[]
}

export interface AzureMonitorProbe {
  credentials_configured: boolean
  auth_mode?: string
  signed_in?: boolean
  tenant_id_set: boolean
  client_id_set: boolean
  client_secret_set: boolean
  subscription_id_set: boolean
  token_ok: boolean
  targets_tested: {
    name: string
    cpu_percent?: number | null
    cpu_max_percent?: number | null
    memory_percent?: number | null
    error?: string | null
  }[]
  ok: boolean
  message: string
}

export interface AzureAuthStatus {
  signed_in: boolean
  username?: string | null
  tenant_id?: string | null
  subscription_id?: string | null
  subscription_id_set: boolean
  signed_in_at?: string | null
  client_id?: string | null
  message: string
  monitor_enabled: boolean
  targets_configured: number
}

export interface AzureLoginSession {
  session_id: string
  status: string
  user_code?: string | null
  verification_uri?: string | null
  message?: string | null
  error?: string | null
  account?: Record<string, unknown>
}

export interface AzureLiveMetrics {
  signed_in: boolean
  monitor_enabled: boolean
  sampled_at: string
  persisted: boolean
  note: string
  servers: {
    name: string
    cpu_percent?: number | null
    cpu_max_percent?: number | null
    memory_percent?: number | null
    error?: string | null
  }[]
}

/** Runs that finished (or were stopped) with results available for comparison. */
export function isComparableTestRun(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export interface CompareNavigationState {
  selectedRunIds?: number[]
}

export interface AppNotificationAction {
  type: string
  label: string
  version?: string
  run_id?: number
}

export interface AppNotification {
  id: number
  kind: string
  title: string
  message: string
  payload?: Record<string, unknown>
  actions: AppNotificationAction[]
  created_at: string
}

export interface UpdateCheck {
  current_version: string
  latest_version?: string
  update_available: boolean
  remote_commit?: string
  repo_available: boolean
  pending_version?: string
  update_started: boolean
}

export type TransactionKind = 'transaction' | 'request'
export type AggregateKindFilter = 'all' | TransactionKind
export type AggregateOutcomeFilter = 'all' | 'pass' | 'fail'

export interface TransactionMetric {
  label: string
  kind?: TransactionKind
  samples: number
  errors: number
  error_pct: number
  avg_ms: number
  min_ms: number
  max_ms: number
  median_ms: number
  p90_ms: number
  p95_ms: number
  p99_ms: number
  throughput: number
}

export interface TransactionTotals {
  samples: number
  errors: number
  error_pct: number
  avg_ms: number
  min_ms: number
  max_ms: number
  median_ms: number
  p90_ms: number
  p95_ms: number
  p99_ms: number
  throughput: number
}

export interface ErrorSample {
  sample_index: number
  timestamp: number
  label: string
  response_code: string
  response_message: string
  failure_message: string
  thread_name: string
  url?: string
  elapsed_ms?: number
}

export interface ErrorDetail {
  sample_index: number
  timestamp: number
  label: string
  response_code: string
  response_message: string
  failure_message: string
  thread_name: string
  url?: string
  elapsed_ms: number
  response_body?: string | null
  response_headers?: string | null
  request_headers?: string | null
  request_body?: string | null
  from_errors_trace?: boolean
}

export interface LiveMetrics {
  test_run_id: number
  status: string
  active_threads: number
  elapsed_seconds: number
  total_samples: number
  total_errors: number
  transactions: TransactionMetric[]
  errors: ErrorSample[]
  response_codes?: { response_code: string; count: number; pct: number }[]
  active_users_series: { t: number; users: number }[]
  throughput_series: { t: number; hits_per_sec: number }[]
}

/** One-shot report payload for finished runs (avoids multi-connection timeouts). */
export interface TestRunReport {
  metrics: LiveMetrics
  errors: ErrorSample[]
  response_time_graph: { mode?: string; series: { label: string; points: { t: number; avg_ms: number }[] }[] }
  errors_graph: { mode?: string; series: { label: string; points: { t: number; errors: number }[] }[] }
}

export interface TestRunLogs {
  content: string
  offset: number
  size: number
  complete: boolean
}

export interface CompareSummary {
  test_run_id: number
  scenario_name: string
  release_name: string
  build_name: string
  status: string
  started_at?: string
  finished_at?: string
  transactions: TransactionMetric[]
}

export interface SystemConfig {
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
  azure_monitor_targets?: AzureMonitorTarget[]
  azure_monitor_sample_interval_seconds?: number
  azure_monitor_resource_group?: string
  azure_credentials_configured?: boolean
  azure_signed_in?: boolean
  jmeter_found: boolean
  updated_at?: string
}

export interface ArchiveRunItem {
  id: number
  scenario_name?: string
  release_name?: string
  build_name?: string
  application_name?: string
  status: string
  finished_at?: string
  is_archived: boolean
  archived_at?: string
  run_dir?: string
}

export interface ArchiveActionResult {
  succeeded: number[]
  failed: { id: number; error: string }[]
}

export interface DeleteByDateResult {
  match_count: number
  sample_ids: number[]
  deleted: number[]
  failed: { id: number; error: string }[]
}

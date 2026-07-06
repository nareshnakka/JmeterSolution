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

export interface Scenario {
  id: number
  application_id: number
  name: string
  tag?: string
  tags?: string[]
  jmx_filename: string
  description?: string
  created_at: string
}

export interface ScenarioListItem {
  id: number
  name: string
  tags: string[]
  jmx_filename: string
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
  created_at: string
  scenario_name?: string
  release_name?: string
  build_name?: string
  application_name?: string
  scenario_tags?: string[]
}

/** Runs that finished (or were stopped) with results available for comparison. */
export function isComparableTestRun(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export interface CompareNavigationState {
  selectedRunIds?: number[]
}

export interface TransactionMetric {
  label: string
  samples: number
  errors: number
  error_pct: number
  avg_ms: number
  min_ms: number
  max_ms: number
  median_ms: number
  p90_ms: number
  p95_ms: number
  throughput: number
}

export interface ErrorSample {
  timestamp: number
  label: string
  response_code: string
  response_message: string
  failure_message: string
  thread_name: string
  url?: string
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
  active_users_series: { t: number; users: number }[]
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

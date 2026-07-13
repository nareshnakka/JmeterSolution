import type { SystemConfig } from '../types'

export interface ConfigFormState {
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
}

export const DEFAULT_CONFIG_FORM: ConfigFormState = {
  jmeter_home: '',
  data_root: '',
  archive_retention_months: 3,
  auto_archive_enabled: true,
  resource_sample_interval_seconds: 10,
  live_dashboard_refresh_interval_seconds: 10,
  aggregate_total_avg_title: 'Total Avg',
  aggregate_total_avg_filter: '',
  aggregate_total_avg_exclude: '',
  aggregate_load_avg_title: 'Load Avg',
  aggregate_load_avg_filter: '_L_',
  aggregate_submit_avg_title: 'Submit Avg',
  aggregate_submit_avg_filter: '_S_',
}

export function configFormFromSystem(data: SystemConfig): ConfigFormState {
  return {
    jmeter_home: data.jmeter_home,
    data_root: data.data_root,
    archive_retention_months: data.archive_retention_months,
    auto_archive_enabled: data.auto_archive_enabled,
    resource_sample_interval_seconds: data.resource_sample_interval_seconds,
    live_dashboard_refresh_interval_seconds: data.live_dashboard_refresh_interval_seconds,
    aggregate_total_avg_title: data.aggregate_total_avg_title ?? 'Total Avg',
    aggregate_total_avg_filter: data.aggregate_total_avg_filter ?? '',
    aggregate_total_avg_exclude: data.aggregate_total_avg_exclude ?? '',
    aggregate_load_avg_title: data.aggregate_load_avg_title ?? 'Load Avg',
    aggregate_load_avg_filter: data.aggregate_load_avg_filter ?? '_L_',
    aggregate_submit_avg_title: data.aggregate_submit_avg_title ?? 'Submit Avg',
    aggregate_submit_avg_filter: data.aggregate_submit_avg_filter ?? '_S_',
  }
}

export function aggregateSummaryBody(form: ConfigFormState) {
  return {
    aggregate_total_avg_title: form.aggregate_total_avg_title,
    aggregate_total_avg_filter: form.aggregate_total_avg_filter,
    aggregate_total_avg_exclude: form.aggregate_total_avg_exclude,
    aggregate_load_avg_title: form.aggregate_load_avg_title,
    aggregate_load_avg_filter: form.aggregate_load_avg_filter,
    aggregate_submit_avg_title: form.aggregate_submit_avg_title,
    aggregate_submit_avg_filter: form.aggregate_submit_avg_filter,
  }
}

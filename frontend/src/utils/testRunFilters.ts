import type { TestRun } from '../types'

export interface TestRunColumnFilters {
  id: string
  release: string
  build: string
  application: string
  scenario: string
  tags: string
  runType: string
  status: string
  scheduledFrom: string
  scheduledTo: string
  startedFrom: string
  startedTo: string
  finishedFrom: string
  finishedTo: string
}

export const EMPTY_RUN_FILTERS: TestRunColumnFilters = {
  id: '',
  release: '',
  build: '',
  application: '',
  scenario: '',
  tags: '',
  runType: '',
  status: '',
  scheduledFrom: '',
  scheduledTo: '',
  startedFrom: '',
  startedTo: '',
  finishedFrom: '',
  finishedTo: '',
}

function includes(value: string | undefined, q: string): boolean {
  if (!q.trim()) return true
  return (value ?? '').toLowerCase().includes(q.trim().toLowerCase())
}

function includesTags(tags: string[] | undefined, q: string): boolean {
  if (!q.trim()) return true
  const needle = q.trim().toLowerCase()
  return tags?.some((t) => t.toLowerCase().includes(needle)) ?? false
}

function inDateRange(iso: string | undefined, from: string, to: string): boolean {
  if (!from && !to) return true
  if (!iso) return false
  const ts = new Date(iso).getTime()
  if (from && ts < new Date(from).getTime()) return false
  if (to && ts > new Date(to).getTime()) return false
  return true
}

export function filterTestRuns(runs: TestRun[], f: TestRunColumnFilters): TestRun[] {
  return runs.filter((r) => {
    if (f.id.trim() && !String(r.id).includes(f.id.trim())) return false
    if (!includes(r.release_name, f.release)) return false
    if (!includes(r.build_name, f.build)) return false
    if (!includes(r.application_name, f.application)) return false
    if (!includes(r.scenario_name, f.scenario)) return false
    if (!includesTags(r.scenario_tags, f.tags)) return false
    if (f.runType && r.run_type !== f.runType) return false
    if (f.status && r.status !== f.status) return false
    if (!inDateRange(r.scheduled_at, f.scheduledFrom, f.scheduledTo)) return false
    if (!inDateRange(r.started_at, f.startedFrom, f.startedTo)) return false
    if (!inDateRange(r.finished_at, f.finishedFrom, f.finishedTo)) return false
    return true
  })
}

export function hasActiveRunFilters(f: TestRunColumnFilters): boolean {
  return Object.values(f).some((v) => v.trim() !== '')
}

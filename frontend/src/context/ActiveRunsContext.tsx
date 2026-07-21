import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import type { TestRunActivity } from '../types'

/** Poll intervals for list pages / notifications when a test is active. */
export const ACTIVE_POLL = {
  testRunsMs: 5_000,
  scenariosMs: 8_000,
  queueMs: 4_000,
  notificationsMs: 15_000,
} as const

/** Slower intervals when the server is idle (no running/pending tests). */
export const IDLE_POLL = {
  testRunsMs: 30_000,
  scenariosMs: 30_000,
  queueMs: 20_000,
  notificationsMs: 60_000,
} as const

const ACTIVITY_POLL_ACTIVE_MS = 5_000
const ACTIVITY_POLL_IDLE_MS = 15_000

interface ActiveRunsContextValue {
  hasActive: boolean
  running: number
  pending: number
  /** Re-check activity immediately (e.g. after starting a test). */
  refreshActivity: () => Promise<void>
  /** Interval for a list page based on current activity. */
  pollMs: (activeMs: number, idleMs: number) => number
}

const ActiveRunsContext = createContext<ActiveRunsContextValue | null>(null)

const EMPTY_ACTIVITY: TestRunActivity = {
  running: 0,
  pending: 0,
  has_active: false,
}

export function ActiveRunsProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<TestRunActivity>(EMPTY_ACTIVITY)

  const refreshActivity = useCallback(async () => {
    try {
      const next = await api.getTestRunActivity()
      setActivity(next)
    } catch {
      /* server may be restarting */
    }
  }, [])

  useEffect(() => {
    void refreshActivity()
  }, [refreshActivity])

  useEffect(() => {
    const ms = activity.has_active ? ACTIVITY_POLL_ACTIVE_MS : ACTIVITY_POLL_IDLE_MS
    const timer = window.setInterval(() => void refreshActivity(), ms)
    return () => window.clearInterval(timer)
  }, [activity.has_active, refreshActivity])

  const value = useMemo<ActiveRunsContextValue>(
    () => ({
      hasActive: activity.has_active,
      running: activity.running,
      pending: activity.pending,
      refreshActivity,
      pollMs: (activeMs, idleMs) => (activity.has_active ? activeMs : idleMs),
    }),
    [activity, refreshActivity]
  )

  return <ActiveRunsContext.Provider value={value}>{children}</ActiveRunsContext.Provider>
}

export function useActiveRuns(): ActiveRunsContextValue {
  const ctx = useContext(ActiveRunsContext)
  if (!ctx) {
    throw new Error('useActiveRuns must be used within ActiveRunsProvider')
  }
  return ctx
}

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import { useToast } from '../components/Toast'

export type PendingArchiveOp = 'archiving' | 'extracting'
export type ArchiveAction = 'archive' | 'restore' | 'auto'

interface ArchiveOperationsContextValue {
  pendingOps: Map<number, PendingArchiveOp>
  archiveAction: ArchiveAction | null
  archiveBusy: boolean
  completedGeneration: number
  archiveRuns: (ids: number[]) => Promise<void>
  restoreRuns: (ids: number[]) => Promise<void>
  runAutoArchive: () => Promise<void>
  getPendingOp: (runId: number) => PendingArchiveOp | undefined
}

const ArchiveOperationsContext = createContext<ArchiveOperationsContextValue | null>(null)

export function ArchiveOperationsProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [pendingOps, setPendingOps] = useState<Map<number, PendingArchiveOp>>(() => new Map())
  const [archiveAction, setArchiveAction] = useState<ArchiveAction | null>(null)
  const [completedGeneration, setCompletedGeneration] = useState(0)
  const inFlightRef = useRef(false)

  const markPending = useCallback((ids: number[], op: PendingArchiveOp) => {
    setPendingOps((prev) => {
      const next = new Map(prev)
      ids.forEach((id) => next.set(id, op))
      return next
    })
  }, [])

  const clearPending = useCallback((ids: number[]) => {
    setPendingOps((prev) => {
      const next = new Map(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }, [])

  const bumpCompleted = useCallback(() => {
    setCompletedGeneration((g) => g + 1)
  }, [])

  const archiveRuns = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0 || inFlightRef.current) return
      inFlightRef.current = true
      markPending(ids, 'archiving')
      setArchiveAction('archive')
      try {
        const result = await api.archiveRuns(ids)
        if (result.succeeded.length) {
          toast.success(`Archived ${result.succeeded.length} run(s)`)
        }
        if (result.failed.length) {
          toast.error(result.failed.map((f) => `#${f.id}: ${f.error}`).join('; '))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Archive failed')
      } finally {
        clearPending(ids)
        setArchiveAction(null)
        inFlightRef.current = false
        bumpCompleted()
      }
    },
    [markPending, clearPending, bumpCompleted, toast]
  )

  const restoreRuns = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0 || inFlightRef.current) return
      inFlightRef.current = true
      markPending(ids, 'extracting')
      setArchiveAction('restore')
      try {
        const result = await api.restoreRuns(ids)
        if (result.succeeded.length) {
          toast.success(`Restored ${result.succeeded.length} run(s)`)
        }
        if (result.failed.length) {
          toast.error(result.failed.map((f) => `#${f.id}: ${f.error}`).join('; '))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Restore failed')
      } finally {
        clearPending(ids)
        setArchiveAction(null)
        inFlightRef.current = false
        bumpCompleted()
      }
    },
    [markPending, clearPending, bumpCompleted, toast]
  )

  const runAutoArchive = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setArchiveAction('auto')
    try {
      const result = await api.runAutoArchive()
      if (result.archived.length) {
        toast.success(
          `Auto-archived ${result.archived.length} run(s) older than ${result.retention_months} month(s)`
        )
      } else {
        toast.success(`No runs older than ${result.retention_months} month(s) to archive`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Auto-archive failed')
    } finally {
      setArchiveAction(null)
      inFlightRef.current = false
      bumpCompleted()
    }
  }, [bumpCompleted, toast])

  const getPendingOp = useCallback(
    (runId: number) => pendingOps.get(runId),
    [pendingOps]
  )

  const value = useMemo(
    () => ({
      pendingOps,
      archiveAction,
      archiveBusy: archiveAction !== null,
      completedGeneration,
      archiveRuns,
      restoreRuns,
      runAutoArchive,
      getPendingOp,
    }),
    [
      pendingOps,
      archiveAction,
      completedGeneration,
      archiveRuns,
      restoreRuns,
      runAutoArchive,
      getPendingOp,
    ]
  )

  return (
    <ArchiveOperationsContext.Provider value={value}>
      {children}
    </ArchiveOperationsContext.Provider>
  )
}

export function useArchiveOperations() {
  const ctx = useContext(ArchiveOperationsContext)
  if (!ctx) {
    throw new Error('useArchiveOperations must be used within ArchiveOperationsProvider')
  }
  return ctx
}

export function ArchiveGlobalStatus() {
  const { pendingOps, archiveAction } = useArchiveOperations()
  const count = pendingOps.size
  if (count === 0 || !archiveAction) return null

  const label =
    archiveAction === 'restore'
      ? `Extracting ${count} run(s)…`
      : archiveAction === 'auto'
        ? 'Auto-archiving runs…'
        : `Archiving ${count} run(s)…`

  return (
    <div className="archive-global-status" role="status" aria-live="polite">
      {label}
    </div>
  )
}

export function archiveStateBadge(
  r: { id: number; is_archived: boolean },
  pending?: PendingArchiveOp
) {
  if (pending === 'archiving') {
    return <span className="badge badge-archiving">Archiving…</span>
  }
  if (pending === 'extracting') {
    return <span className="badge badge-extracting">Extracting…</span>
  }
  if (r.is_archived) {
    return <span className="badge badge-cancelled">Archived</span>
  }
  return <span className="badge badge-completed">Active</span>
}

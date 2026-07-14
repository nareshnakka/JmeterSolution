import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import { useToast } from '../components/Toast'
import type { AppNotification, UpdateCheck } from '../types'

interface NotificationsContextValue {
  notifications: AppNotification[]
  unreadCount: number
  panelOpen: boolean
  selectedIds: Set<number>
  updateCheck: UpdateCheck | null
  loading: boolean
  applyingUpdate: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  refresh: () => Promise<void>
  toggleSelected: (id: number) => void
  selectAll: () => void
  clearSelection: () => void
  clearSelected: () => Promise<void>
  clearAll: () => Promise<void>
  applyUpdate: (version: string) => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

const NOTIFICATION_POLL_MS = 15_000
const UPDATE_CHECK_MS = 5 * 60_000

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [applyingUpdate, setApplyingUpdate] = useState(false)
  const lastUpdateCheckRef = useRef(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [items, status] = await Promise.all([
        api.getNotifications(),
        api.getUpdateStatus(),
      ])
      setNotifications(items)
      setUpdateCheck(status)

      const now = Date.now()
      if (now - lastUpdateCheckRef.current >= UPDATE_CHECK_MS) {
        lastUpdateCheckRef.current = now
        const check = await api.checkForUpdates()
        setUpdateCheck(check)
        const fresh = await api.getNotifications()
        setNotifications(fresh)
      }
    } catch {
      /* server may be restarting during update */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), NOTIFICATION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(notifications.map((n) => n.id)))
  }, [notifications])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const clearSelected = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    try {
      const result = await api.clearNotifications(ids)
      toast.success(`Cleared ${result.deleted} notification(s)`)
      setSelectedIds(new Set())
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clear notifications')
    }
  }, [selectedIds, refresh, toast])

  const clearAll = useCallback(async () => {
    if (notifications.length === 0) return
    if (!window.confirm(`Clear all ${notifications.length} notification(s)?`)) return
    try {
      const result = await api.clearNotifications()
      toast.success(`Cleared ${result.deleted} notification(s)`)
      setSelectedIds(new Set())
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clear notifications')
    }
  }, [notifications.length, refresh, toast])

  const applyUpdate = useCallback(
    async (version: string) => {
      const message =
        `Install ${version} from GitHub?\n\n` +
        'The UI server will restart briefly. Any running JMeter test continues generating results, ' +
        'and the Live Dashboard reconnects to the same run after the update (no data loss).'
      if (!window.confirm(message)) return

      setApplyingUpdate(true)
      try {
        const result = await api.applyUpdate(version)
        toast.info(result.message)
        await refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to start update')
      } finally {
        setApplyingUpdate(false)
      }
    },
    [refresh, toast]
  )

  const value = useMemo(
    () => ({
      notifications,
      unreadCount: notifications.length,
      panelOpen,
      selectedIds,
      updateCheck,
      loading,
      applyingUpdate,
      openPanel: () => setPanelOpen(true),
      closePanel: () => setPanelOpen(false),
      togglePanel: () => setPanelOpen((open) => !open),
      refresh,
      toggleSelected,
      selectAll,
      clearSelection,
      clearSelected,
      clearAll,
      applyUpdate,
    }),
    [
      notifications,
      panelOpen,
      selectedIds,
      updateCheck,
      loading,
      applyingUpdate,
      refresh,
      toggleSelected,
      selectAll,
      clearSelection,
      clearSelected,
      clearAll,
      applyUpdate,
    ]
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationsProvider')
  return ctx
}

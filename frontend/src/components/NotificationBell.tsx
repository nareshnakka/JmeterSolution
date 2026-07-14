import { memo, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useNotifications } from '../context/NotificationsContext'
import type { AppNotification } from '../types'

function kindIcon(kind: string) {
  if (kind.startsWith('test_') || kind === 'run_resumed') return '●'
  if (kind.startsWith('host_')) return '⚠'
  if (kind.startsWith('update_')) return '↑'
  return 'i'
}

function NotificationItem({
  note,
  selected,
  onToggle,
  onAction,
  applyingUpdate,
}: {
  note: AppNotification
  selected: boolean
  onToggle: () => void
  onAction: (action: AppNotification['actions'][number]) => void
  applyingUpdate: boolean
}) {
  return (
    <div className={`notification-item ${selected ? 'selected' : ''}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select notification ${note.title}`}
      />
      <div className="notification-item-body">
        <div className="notification-item-header">
          <span className="notification-kind" aria-hidden>{kindIcon(note.kind)}</span>
          <strong>{note.title}</strong>
          <time className="notification-time">
            {new Date(note.created_at).toLocaleString()}
          </time>
        </div>
        <p className="notification-message">{note.message}</p>
        {note.actions.length > 0 && (
          <div className="notification-actions">
            {note.actions.map((action) =>
              action.type === 'view_run' && action.run_id ? (
                <Link
                  key={`${action.type}-${action.run_id}`}
                  to={`/live/${action.run_id}`}
                  className="btn btn-secondary"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                >
                  {action.label}
                </Link>
              ) : (
                <button
                  key={`${action.type}-${action.version ?? action.label}`}
                  type="button"
                  className="btn"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                  disabled={applyingUpdate}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const NotificationBell = memo(function NotificationBell() {
  const {
    notifications,
    unreadCount,
    panelOpen,
    selectedIds,
    updateCheck,
    loading,
    applyingUpdate,
    togglePanel,
    closePanel,
    toggleSelected,
    selectAll,
    clearSelection,
    clearSelected,
    clearAll,
    applyUpdate,
  } = useNotifications()

  const panelRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!panelOpen) return
    function onDocClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePanel()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [panelOpen, closePanel])

  function handleAction(action: AppNotification['actions'][number]) {
    if (action.type === 'update' && action.version) {
      void applyUpdate(action.version)
      return
    }
    if ((action.type === 'view_run' || action.type === 'open_live') && action.run_id) {
      closePanel()
      navigate(`/live/${action.run_id}`)
    }
  }

  return (
    <div className="notification-bell-wrap" ref={panelRef}>
      <button
        type="button"
        className="notification-bell-btn"
        onClick={togglePanel}
        aria-label={`Notifications (${unreadCount})`}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {panelOpen && (
        <div className="notification-panel" role="dialog" aria-label="Notification history">
          <div className="notification-panel-header">
            <h3>Notifications</h3>
            {updateCheck?.update_available && updateCheck.latest_version && (
              <span className="notification-update-pill">
                {updateCheck.latest_version} available
              </span>
            )}
          </div>

          <div className="notification-panel-toolbar">
            <button type="button" className="btn btn-secondary" onClick={selectAll} disabled={!notifications.length}>
              Select all
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
            >
              Clear selection
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void clearSelected()}
              disabled={selectedIds.size === 0}
            >
              Clear selected
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void clearAll()}
              disabled={!notifications.length}
            >
              Clear all
            </button>
          </div>

          <div className="notification-panel-list">
            {loading && notifications.length === 0 ? (
              <p className="empty">Loading…</p>
            ) : notifications.length === 0 ? (
              <p className="empty">No notifications yet</p>
            ) : (
              notifications.map((note) => (
                <NotificationItem
                  key={note.id}
                  note={note}
                  selected={selectedIds.has(note.id)}
                  onToggle={() => toggleSelected(note.id)}
                  onAction={handleAction}
                  applyingUpdate={applyingUpdate}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
})

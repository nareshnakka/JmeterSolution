import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const LOG_SYNC_MS = 10_000
const MAX_LOG_CHARS = 64_000

interface JmeterLogConsoleProps {
  runId: number
  isRunning: boolean
  refreshIntervalMs?: number
  /** When set, parent drives refresh ticks instead of an internal timer. */
  refreshGeneration?: number
}

export default function JmeterLogConsole({
  runId,
  isRunning,
  refreshIntervalMs,
  refreshGeneration,
}: JmeterLogConsoleProps) {
  const [expanded, setExpanded] = useState(false)
  const [logSize, setLogSize] = useState(0)
  const [complete, setComplete] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const offsetRef = useRef(0)
  const logTextRef = useRef('')
  const bodyRef = useRef<HTMLPreElement>(null)
  const stickToBottomRef = useRef(true)

  const renderLogBody = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    el.textContent = logTextRef.current || 'Waiting for JMeter log output…'
    if (expanded && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [expanded])

  const syncLogs = useCallback(async () => {
    try {
      const data = await api.getLogs(runId, offsetRef.current)
      if (data.content) {
        logTextRef.current += data.content
        if (logTextRef.current.length > MAX_LOG_CHARS) {
          logTextRef.current = `… (log trimmed to last ${Math.round(MAX_LOG_CHARS / 1024)} KB)\n${logTextRef.current.slice(-MAX_LOG_CHARS)}`
        }
        if (expanded) {
          renderLogBody()
        }
      }
      offsetRef.current = data.offset
      setLogSize(data.size)
      setComplete(data.complete)
      setLastSync(new Date())
    } catch {
      /* log may not exist yet */
    }
  }, [runId, expanded, renderLogBody])

  useEffect(() => {
    offsetRef.current = 0
    logTextRef.current = ''
    setLogSize(0)
    setComplete(false)
    stickToBottomRef.current = true
    void syncLogs()
  }, [runId, syncLogs])

  useEffect(() => {
    if (refreshGeneration !== undefined) return
    const pollMs = refreshIntervalMs ?? LOG_SYNC_MS
    const interval = setInterval(() => void syncLogs(), pollMs)
    return () => clearInterval(interval)
  }, [syncLogs, refreshIntervalMs, refreshGeneration])

  useEffect(() => {
    if (refreshGeneration === undefined || refreshGeneration === 0) return
    void syncLogs()
  }, [refreshGeneration, syncLogs])

  useEffect(() => {
    if (expanded) {
      renderLogBody()
    }
  }, [expanded, renderLogBody])

  function onScroll() {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickToBottomRef.current = atBottom
  }

  const pollSeconds = Math.round((refreshIntervalMs ?? LOG_SYNC_MS) / 1000)

  return (
    <div className={`card log-console ${expanded ? 'log-console-expanded' : 'log-console-collapsed'}`}>
      <button
        type="button"
        className="log-console-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="log-console-title">
          {expanded ? '▼' : '▶'} JMeter Log Console
        </span>
        <span className="log-console-meta">
          {logSize > 0 && `${(logSize / 1024).toFixed(1)} KB`}
          {lastSync && ` · synced ${lastSync.toLocaleTimeString()}`}
          {isRunning && !complete && ' · live'}
        </span>
      </button>
      {expanded && (
        <div className="log-console-body-wrap">
          <pre ref={bodyRef} className="log-console-body" onScroll={onScroll} />
          <div className="log-console-footer">
            <span>Auto-refresh every {pollSeconds}s</span>
            <button type="button" className="btn btn-secondary log-console-refresh" onClick={() => void syncLogs()}>
              Refresh now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

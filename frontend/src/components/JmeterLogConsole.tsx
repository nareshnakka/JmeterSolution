import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const LOG_SYNC_MS = 10_000

interface JmeterLogConsoleProps {
  runId: number
  isRunning: boolean
}

export default function JmeterLogConsole({ runId, isRunning }: JmeterLogConsoleProps) {
  const [expanded, setExpanded] = useState(true)
  const [logText, setLogText] = useState('')
  const [logSize, setLogSize] = useState(0)
  const [complete, setComplete] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const offsetRef = useRef(0)
  const bodyRef = useRef<HTMLPreElement>(null)
  const stickToBottomRef = useRef(true)

  const syncLogs = useCallback(async () => {
    try {
      const data = await api.getLogs(runId, offsetRef.current)
      if (data.content) {
        setLogText((prev) => prev + data.content)
      }
      offsetRef.current = data.offset
      setLogSize(data.size)
      setComplete(data.complete)
      setLastSync(new Date())
    } catch {
      /* log may not exist yet */
    }
  }, [runId])

  useEffect(() => {
    offsetRef.current = 0
    setLogText('')
    setLogSize(0)
    setComplete(false)
    stickToBottomRef.current = true
    syncLogs()
  }, [runId, syncLogs])

  useEffect(() => {
    const interval = setInterval(syncLogs, LOG_SYNC_MS)
    return () => clearInterval(interval)
  }, [syncLogs])

  useEffect(() => {
    if (expanded && stickToBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [logText, expanded])

  function onScroll() {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickToBottomRef.current = atBottom
  }

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
          <pre ref={bodyRef} className="log-console-body" onScroll={onScroll}>
            {logText || 'Waiting for JMeter log output…'}
          </pre>
          <div className="log-console-footer">
            <span>Auto-refresh every 10s</span>
            <button type="button" className="btn btn-secondary log-console-refresh" onClick={syncLogs}>
              Refresh now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api } from '../api'

const STORAGE_KEY = 'jmeterAgent.lastLiveRunId'

/**
 * After a server update/restart, offer a one-click return to the last Live Dashboard
 * if that test is still running (JMeter continues through the UI restart).
 */
export default function ResumeLiveBanner() {
  const location = useLocation()
  const [runId, setRunId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      let stored: string | null = null
      try {
        stored = sessionStorage.getItem(STORAGE_KEY)
      } catch {
        return
      }
      if (!stored) return
      const id = Number(stored)
      if (!Number.isFinite(id) || id <= 0) return
      if (location.pathname === `/live/${id}`) return
      try {
        const run = await api.getTestRun(id)
        if (cancelled) return
        if (run.status === 'running' || run.status === 'pending') {
          setRunId(id)
        } else {
          setRunId(null)
        }
      } catch {
        if (!cancelled) setRunId(null)
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [location.pathname])

  if (!runId) return null

  return (
    <div className="resume-live-banner" role="status">
      <span>
        Test run #{runId} is still running after the server update.
      </span>
      <Link className="btn btn-secondary" to={`/live/${runId}`}>
        Return to Live Dashboard
      </Link>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setRunId(null)}
      >
        Dismiss
      </button>
    </div>
  )
}

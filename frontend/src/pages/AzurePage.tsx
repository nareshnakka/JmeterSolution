import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useToast } from '../components/Toast'
import type { AzureAuthStatus, AzureLiveMetrics, AzureLoginSession } from '../types'

export default function AzurePage() {
  const toast = useToast()
  const [status, setStatus] = useState<AzureAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [signingIn, setSigningIn] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [session, setSession] = useState<AzureLoginSession | null>(null)
  const [live, setLive] = useState<AzureLiveMetrics | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.getAzureStatus()
      setStatus(next)
      return next
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Azure status')
      return null
    } finally {
      setLoading(false)
    }
  }, [toast])

  const refreshLive = useCallback(async () => {
    try {
      const metrics = await api.getAzureLiveMetrics()
      setLive(metrics)
      setLiveError(null)
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Failed to load live metrics')
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!status?.signed_in) {
      setLive(null)
      return
    }
    void refreshLive()
    const id = window.setInterval(() => void refreshLive(), 15_000)
    return () => window.clearInterval(id)
  }, [status?.signed_in, refreshLive])

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const startSignIn = async () => {
    setSigningIn(true)
    setSession(null)
    stopPolling()
    try {
      const started = await api.startAzureLogin()
      setSession(started)
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const next = await api.pollAzureLogin(started.session_id)
            setSession(next)
            if (next.status === 'success') {
              stopPolling()
              setSigningIn(false)
              toast.success(next.message || 'Signed in to Azure')
              await refreshStatus()
            } else if (next.status === 'failed' || next.status === 'cancelled') {
              stopPolling()
              setSigningIn(false)
              if (next.status === 'failed') {
                toast.error(next.error || next.message || 'Azure sign-in failed')
              }
            }
          } catch (err) {
            stopPolling()
            setSigningIn(false)
            toast.error(err instanceof Error ? err.message : 'Login poll failed')
          }
        })()
      }, 2000)
    } catch (err) {
      setSigningIn(false)
      toast.error(err instanceof Error ? err.message : 'Failed to start Azure sign-in')
    }
  }

  const cancelSignIn = async () => {
    if (!session?.session_id) return
    try {
      await api.cancelAzureLogin(session.session_id)
    } catch {
      /* ignore */
    }
    stopPolling()
    setSigningIn(false)
    setSession((prev) =>
      prev ? { ...prev, status: 'cancelled', message: 'Sign-in cancelled.' } : prev,
    )
  }

  const signOut = async () => {
    setSigningOut(true)
    try {
      const next = await api.azureLogout()
      setStatus(next)
      setLive(null)
      setSession(null)
      toast.success('Signed out of Azure')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-out failed')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      <h1 className="page-title">Azure Monitor</h1>
      <p className="page-lead">
        Sign in with Microsoft to sync target VM CPU/Memory. Metrics are saved only while a test
        run is active and appear automatically on the Live Dashboard.
      </p>

      <div className="card">
        <h2>Microsoft sign-in</h2>
        {loading ? (
          <p className="config-hint">Loading…</p>
        ) : (
          <>
            <p className={`config-hint ${status?.signed_in ? 'config-ok' : 'config-warn'}`}>
              {status?.message}
              {status?.username ? ` (${status.username})` : null}
            </p>
            {!status?.subscription_id_set ? (
              <p className="config-hint config-warn">
                Set <code>AZURE_SUBSCRIPTION_ID</code> in the project-root <code>.env</code>, then
                restart the server before signing in.
              </p>
            ) : null}
            {status?.signed_in ? (
              <div className="toolbar" style={{ gap: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" disabled={signingOut} onClick={() => void signOut()}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
                <Link to="/config" className="btn btn-secondary">
                  Configure target VMs
                </Link>
              </div>
            ) : (
              <div className="toolbar" style={{ gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={signingIn || !status?.subscription_id_set}
                  onClick={() => void startSignIn()}
                >
                  {signingIn ? 'Waiting for Microsoft…' : 'Sign in with Microsoft'}
                </button>
                {signingIn ? (
                  <button type="button" className="btn btn-secondary" onClick={() => void cancelSignIn()}>
                    Cancel
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}

        {session && (session.status === 'pending' || session.status === 'waiting_user') ? (
          <div className="azure-device-code" style={{ marginTop: '1rem' }}>
            <p className="config-section-hint">
              Open the Microsoft device login page and enter this code:
            </p>
            <p style={{ fontSize: '1.75rem', fontWeight: 700, letterSpacing: '0.12em', margin: '0.5rem 0' }}>
              {session.user_code || '…'}
            </p>
            {session.verification_uri ? (
              <p>
                <a href={session.verification_uri} target="_blank" rel="noreferrer">
                  {session.verification_uri}
                </a>
              </p>
            ) : (
              <p className="config-hint">Starting device login…</p>
            )}
            <p className="config-hint">{session.message}</p>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Live metrics preview</h2>
        <p className="config-section-hint">
          While signed in, values refresh here for verification. They are <strong>not saved</strong>{' '}
          until a test starts — then the Live Dashboard charts them for that run.
        </p>
        {!status?.signed_in ? (
          <p className="config-hint config-warn">Sign in to start syncing monitoring metrics.</p>
        ) : (
          <>
            <p className={`config-hint ${status.monitor_enabled ? 'config-ok' : 'config-warn'}`}>
              {status.monitor_enabled
                ? `Sampling enabled for test runs · ${status.targets_configured} VM(s) configured`
                : 'Sampling not enabled yet — it turns on automatically after a successful sign-in.'}
            </p>
            {liveError ? <p className="config-hint config-warn">{liveError}</p> : null}
            {live?.note ? <p className="config-hint">{live.note}</p> : null}
            {live?.servers?.length ? (
              <table className="data-table" style={{ marginTop: '0.75rem' }}>
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>CPU %</th>
                    <th>Memory %</th>
                  </tr>
                </thead>
                <tbody>
                  {live.servers.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.cpu_percent != null ? s.cpu_percent : '—'}</td>
                      <td>{s.memory_percent != null ? s.memory_percent : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : status.signed_in ? (
              <p className="config-hint">
                No target VMs yet.{' '}
                <Link to="/config">Add servers in Configuration</Link>.
              </p>
            ) : null}
            {live?.sampled_at ? (
              <p className="config-hint" style={{ marginTop: '0.5rem' }}>
                Last preview sample: {new Date(live.sampled_at).toLocaleString()}
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { useMatch } from 'react-router-dom'
import { api } from '../api'
import { useToast } from './Toast'

interface ReportBugModalProps {
  open: boolean
  onClose: () => void
  defaultRunId?: number | null
}

export function ReportBugButton() {
  const [open, setOpen] = useState(false)
  const live = useMatch('/live/:runId')
  const runId = live?.params.runId ? Number(live.params.runId) : null

  return (
    <>
      <button
        type="button"
        className="notification-bell-btn report-bug-btn"
        onClick={() => setOpen(true)}
        title="Report a bug"
        aria-label="Report a bug"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
        </svg>
        <span className="report-bug-label">Report Bug</span>
      </button>
      {open && (
        <ReportBugModal
          open={open}
          onClose={() => setOpen(false)}
          defaultRunId={Number.isFinite(runId) ? runId : null}
        />
      )}
    </>
  )
}

export default function ReportBugModal({ open, onClose, defaultRunId }: ReportBugModalProps) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [runId, setRunId] = useState(defaultRunId ? String(defaultRunId) : '')
  const [screenshot, setScreenshot] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [repo, setRepo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setRunId(defaultRunId ? String(defaultRunId) : '')
    setScreenshot(null)
    setPreviewUrl(null)
    setError('')
    api
      .getBugReportStatus()
      .then((s) => {
        setConfigured(s.configured)
        setRepo(s.repo)
      })
      .catch(() => setConfigured(false))
  }, [open, defaultRunId])

  useEffect(() => {
    if (!screenshot) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(screenshot)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [screenshot])

  const canSubmit = useMemo(
    () => Boolean(title.trim()) && configured === true && !submitting,
    [title, configured, submitting]
  )

  if (!open) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const form = new FormData()
      form.append('title', title.trim())
      form.append('description', description.trim())
      form.append('page_url', window.location.href)
      form.append('user_agent', navigator.userAgent)
      const parsedRun = runId.trim() ? Number(runId.trim()) : NaN
      if (Number.isFinite(parsedRun) && parsedRun > 0) {
        form.append('run_id', String(parsedRun))
      }
      if (screenshot) {
        form.append('screenshot', screenshot)
      }
      const result = await api.submitBugReport(form)
      toast.success(`Bug #${result.issue_number} created`)
      onClose()
      window.open(result.issue_url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit bug report')
    } finally {
      setSubmitting(false)
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          setScreenshot(file)
          e.preventDefault()
        }
        break
      }
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel report-bug-panel" onClick={(e) => e.stopPropagation()} onPaste={onPaste}>
        <div className="modal-header">
          <h2>Report Bug</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="modal-subtitle">
          Creates a GitHub Issue with server logs (and the related test run logs). You can attach a
          screenshot. After a freeze, report once the UI is back — logs are kept on disk.
        </p>

        {configured === false && (
          <p className="modal-error">
            Report Bug is not configured on this server. Set <code>GITHUB_TOKEN</code> in{' '}
            <code>.env</code> (classic PAT with <code>repo</code> scope) and restart.
          </p>
        )}
        {configured && repo && (
          <p className="modal-current-file">
            Issues go to <strong>{repo}</strong>
          </p>
        )}

        <form onSubmit={onSubmit} className="report-bug-form">
          <label className="form-field">
            <span>Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. UI freezes during long test run"
              required
              maxLength={120}
              disabled={submitting}
            />
          </label>

          <label className="form-field">
            <span>What happened?</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Steps, expected vs actual, and anything else useful…"
              disabled={submitting}
            />
          </label>

          <label className="form-field">
            <span>Test run ID (optional)</span>
            <input
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder="Auto-uses running / latest run if empty"
              inputMode="numeric"
              disabled={submitting}
            />
          </label>

          <div className="form-field">
            <span>Screenshot (optional)</span>
            <div className="report-bug-shot-row">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
                disabled={submitting}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={submitting || !screenshot}
                onClick={() => {
                  setScreenshot(null)
                  if (fileRef.current) fileRef.current.value = ''
                }}
              >
                Clear
              </button>
            </div>
            <p className="form-hint">Paste an image here (Ctrl+V) or choose a file. Max 5 MB.</p>
            {previewUrl && (
              <img src={previewUrl} alt="Screenshot preview" className="report-bug-preview" />
            )}
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Submit to GitHub'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

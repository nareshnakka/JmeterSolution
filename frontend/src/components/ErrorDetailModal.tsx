import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ErrorDetail, ErrorSample } from '../types'

interface ErrorDetailModalProps {
  runId: number
  error: ErrorSample
  onClose: () => void
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="error-detail-row">
      <span className="error-detail-label">{label}</span>
      <span className="error-detail-value">{value}</span>
    </div>
  )
}

export default function ErrorDetailModal({ runId, error, onClose }: ErrorDetailModalProps) {
  const [detail, setDetail] = useState<ErrorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    setLoading(true)
    setLoadError('')
    api.getRunErrorDetail(runId, error.sample_index)
      .then(setDetail)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load error details'))
      .finally(() => setLoading(false))
  }, [runId, error.sample_index])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel error-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Error Response Details</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="modal-subtitle">
          <strong>{error.label}</strong> · [{error.response_code}] {error.response_message}
        </p>

        {loading ? (
          <p className="modal-current-file">Loading error details…</p>
        ) : loadError ? (
          <p className="modal-error">{loadError}</p>
        ) : detail ? (
          <>
            <div className="error-detail-meta">
              <DetailRow label="Thread" value={detail.thread_name} />
              <DetailRow label="URL" value={detail.url} />
              <DetailRow label="Elapsed" value={`${detail.elapsed_ms} ms`} />
              <DetailRow
                label="Time"
                value={new Date(detail.timestamp).toLocaleString()}
              />
              <DetailRow label="Failure message" value={detail.failure_message} />
            </div>

            {detail.request_headers && (
              <>
                <h3 className="error-detail-section">Request headers</h3>
                <pre className="error-detail-body">{detail.request_headers}</pre>
              </>
            )}

            {detail.response_headers && (
              <>
                <h3 className="error-detail-section">Response headers</h3>
                <pre className="error-detail-body">{detail.response_headers}</pre>
              </>
            )}

            <h3 className="error-detail-section">Response body</h3>
            {detail.response_body ? (
              <pre className="error-detail-body">{detail.response_body}</pre>
            ) : (
              <p className="modal-current-file">
                No response body captured for this error. New test runs store response bodies
                automatically for failed samples.
              </p>
            )}
          </>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

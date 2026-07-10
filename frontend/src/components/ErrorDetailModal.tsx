import { useEffect, useMemo, useState } from 'react'
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

  const display = detail ?? error

  const responseBody = useMemo(() => {
    if (detail?.response_body?.trim()) return detail.response_body
    if (detail?.failure_message?.trim()) return detail.failure_message
    if (error.failure_message?.trim()) return error.failure_message
    if (detail?.response_message?.trim() && detail.response_message !== 'OK') {
      return detail.response_message
    }
    return null
  }, [detail, error.failure_message])

  const requestBody = detail?.request_body?.trim() || null
  const hasHeaders = Boolean(detail?.request_headers?.trim() || detail?.response_headers?.trim())
  const hasTrace = Boolean(detail?.from_errors_trace)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel error-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Error Response Details</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="modal-subtitle">
          <strong>{display.label}</strong> · [{display.response_code}] {display.response_message}
        </p>

        {loading ? (
          <p className="modal-current-file">Loading error details…</p>
        ) : (
          <>
            {loadError && <p className="modal-error">{loadError}</p>}

            {hasTrace && (
              <p className="modal-current-file" style={{ marginBottom: '0.75rem' }}>
                Full request/response trace loaded from <strong>errors-trace.jtl</strong>.
              </p>
            )}

            <div className="error-detail-meta">
              <DetailRow label="Sample #" value={String(error.sample_index)} />
              <DetailRow label="Thread" value={display.thread_name} />
              <DetailRow label="URL" value={display.url} />
              <DetailRow
                label="Elapsed"
                value={display.elapsed_ms != null ? `${display.elapsed_ms} ms` : undefined}
              />
              <DetailRow
                label="Time"
                value={
                  display.timestamp
                    ? new Date(Number(display.timestamp)).toLocaleString()
                    : undefined
                }
              />
              <DetailRow label="Failure message" value={display.failure_message} />
            </div>

            {detail?.request_headers && (
              <>
                <h3 className="error-detail-section">Request headers</h3>
                <pre className="error-detail-body">{detail.request_headers}</pre>
              </>
            )}

            {requestBody && (
              <>
                <h3 className="error-detail-section">Request body</h3>
                <pre className="error-detail-body">{requestBody}</pre>
              </>
            )}

            {detail?.response_headers && (
              <>
                <h3 className="error-detail-section">Response headers</h3>
                <pre className="error-detail-body">{detail.response_headers}</pre>
              </>
            )}

            <h3 className="error-detail-section">Response body</h3>
            {responseBody ? (
              <pre className="error-detail-body">{responseBody}</pre>
            ) : (
              <p className="modal-current-file">
                No response body was captured for this error.
                {hasHeaders
                  ? ' Headers are available above.'
                  : hasTrace
                    ? ' The error trace file did not include a response body for this sample.'
                    : ' Run a new test to capture full error traces (errors-trace.jtl in XML format).'}
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <a
            href={api.downloadUrl(runId, 'errors-trace.jtl')}
            className="btn btn-secondary"
            download
          >
            Download errors-trace.jtl
          </a>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'

export const DEFAULT_RUN_DESCRIPTION = 'Verification Test'

interface StartRunModalProps {
  open: boolean
  scenarioName: string
  submitting?: boolean
  onClose: () => void
  onConfirm: (description: string) => void | Promise<void>
}

export default function StartRunModal({
  open,
  scenarioName,
  submitting = false,
  onClose,
  onConfirm,
}: StartRunModalProps) {
  const [description, setDescription] = useState(DEFAULT_RUN_DESCRIPTION)

  useEffect(() => {
    if (open) {
      setDescription(DEFAULT_RUN_DESCRIPTION)
    }
  }, [open, scenarioName])

  if (!open) return null

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const value = description.trim() || DEFAULT_RUN_DESCRIPTION
    await onConfirm(value)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel start-run-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Run Test</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close" disabled={submitting}>
            ×
          </button>
        </div>
        <p className="modal-subtitle">
          Scenario: <strong>{scenarioName}</strong>
        </p>
        <form onSubmit={handleSubmit} className="start-run-form">
          <label className="form-field">
            <span>Run Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={DEFAULT_RUN_DESCRIPTION}
              maxLength={500}
              disabled={submitting}
              autoFocus
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Starting…' : 'Run Test'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

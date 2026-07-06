import { useEffect, useState } from 'react'
import { api } from '../api'
import FilePicker from './FilePicker'
import JmeterPropertiesEditor, {
  appendJmeterPropertiesToForm,
  jmeterPropertiesEqual,
  jmeterPropertiesForEditor,
  normalizeJmeterProperties,
} from './JmeterPropertiesEditor'
import TagInput from './TagInput'
import { useToast } from './Toast'
import type { JmeterProperty, ScenarioFile, ScenarioListItem } from '../types'

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((t, i) => t === sb[i])
}

interface ScenarioEditModalProps {
  scenario: ScenarioListItem
  onClose: () => void
  onSaved: () => void
}

export default function ScenarioEditModal({ scenario, onClose, onSaved }: ScenarioEditModalProps) {
  const toast = useToast()
  const [name, setName] = useState(scenario.name)
  const [tags, setTags] = useState<string[]>(scenario.tags)
  const [jmxFiles, setJmxFiles] = useState<File[]>([])
  const [newDependencies, setNewDependencies] = useState<File[]>([])
  const [existingFiles, setExistingFiles] = useState<ScenarioFile[]>([])
  const [removeFileIds, setRemoveFileIds] = useState<number[]>([])
  const [jmeterProperties, setJmeterProperties] = useState<JmeterProperty[]>(() =>
    jmeterPropertiesForEditor(scenario.jmeter_properties)
  )
  const [initialJmeterProperties, setInitialJmeterProperties] = useState<JmeterProperty[]>(() =>
    normalizeJmeterProperties(scenario.jmeter_properties ?? [])
  )
  const [propertiesLoading, setPropertiesLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setPropertiesLoading(true)
    api.listScenarioFiles(scenario.id).then(setExistingFiles).catch(console.error)
    api.getScenario(scenario.id)
      .then((detail) => {
        if (cancelled) return
        const saved = normalizeJmeterProperties(detail.jmeter_properties ?? [])
        setJmeterProperties(jmeterPropertiesForEditor(saved))
        setInitialJmeterProperties(saved)
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) {
          setJmeterProperties(jmeterPropertiesForEditor(scenario.jmeter_properties))
          setInitialJmeterProperties(normalizeJmeterProperties(scenario.jmeter_properties ?? []))
        }
      })
      .finally(() => {
        if (!cancelled) setPropertiesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scenario.id])

  const visibleDependencies = existingFiles.filter(
    (f) => f.kind === 'dependency' && !removeFileIds.includes(f.id)
  )

  const nameChanged = name.trim() !== scenario.name
  const tagsChanged = !tagsEqual(tags, scenario.tags)
  const hasJmxChange = jmxFiles.length > 0
  const hasDepChanges = newDependencies.length > 0 || removeFileIds.length > 0
  const propertiesChanged = !jmeterPropertiesEqual(jmeterProperties, initialJmeterProperties)
  const hasAnyChange = nameChanged || tagsChanged || hasJmxChange || hasDepChanges || propertiesChanged

  function markFileRemoved(fileId: number) {
    setRemoveFileIds((prev) => [...prev, fileId])
  }

  async function save() {
    if (!hasAnyChange) {
      setError('No changes to save — update one or more fields first')
      return
    }
    if (nameChanged && !name.trim()) {
      setError('Scenario name cannot be empty')
      return
    }

    setSaving(true)
    setError('')
    try {
      const form = new FormData()
      if (nameChanged) form.append('name', name.trim())
      if (tagsChanged) {
        form.append('update_tags', 'true')
        tags.forEach((t) => form.append('tags', t))
      }
      if (jmxFiles[0]) form.append('jmx', jmxFiles[0])
      newDependencies.forEach((f) => form.append('dependencies', f))
      removeFileIds.forEach((id) => form.append('remove_file_ids', String(id)))
      if (propertiesChanged) {
        form.append('update_jmeter_properties', 'true')
        appendJmeterPropertiesToForm(form, jmeterProperties)
      }
      await api.updateScenario(scenario.id, form)
      toast.success(`Scenario "${scenario.name}" saved successfully`)
      onSaved()
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save scenario'
      setError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Edit Scenario</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="modal-subtitle">
          {scenario.release_name} → {scenario.build_name} → {scenario.application_name}
          <br />
          <span style={{ fontSize: '0.75rem' }}>Only the fields you change will be updated.</span>
        </p>

        <div className="form-row">
          <label>Scenario name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="form-row">
          <label>Tags</label>
          <TagInput tags={tags} onChange={setTags} />
        </div>

        <div className="form-row">
          <label>Current JMX script</label>
          <p className="modal-current-file">{scenario.jmx_filename}</p>
        </div>

        <FilePicker
          label="Replace JMX script (optional)"
          buttonText="Select new JMX file"
          accept=".jmx"
          files={jmxFiles}
          onChange={setJmxFiles}
          emptyText="Keep existing JMX file"
        />

        <JmeterPropertiesEditor
          properties={jmeterProperties}
          onChange={setJmeterProperties}
          disabled={saving}
          loading={propertiesLoading}
        />

        <div className="form-row" style={{ marginTop: '1rem' }}>
          <label>Current dependency files</label>
          {visibleDependencies.length === 0 ? (
            <p className="modal-current-file">No dependency files</p>
          ) : (
            <ul className="modal-file-list">
              {visibleDependencies.map((f) => (
                <li key={f.id}>
                  <span>{f.filename}</span>
                  <button
                    type="button"
                    className="file-picker-remove"
                    onClick={() => markFileRemoved(f.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FilePicker
          label="Add or replace CSV / dependency files"
          buttonText="Select CSV / dependency files"
          accept=".csv,.txt,.json,.xml,.properties,.dat"
          multiple
          files={newDependencies}
          onChange={setNewDependencies}
          emptyText="No new files selected (same filename replaces existing)"
        />

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={save} disabled={saving || !hasAnyChange || propertiesLoading}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

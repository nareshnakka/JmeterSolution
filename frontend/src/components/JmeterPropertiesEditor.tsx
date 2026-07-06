import type { JmeterProperty } from '../types'

export function emptyJmeterProperty(): JmeterProperty {
  return { name: '', value: '' }
}

export function normalizeJmeterProperties(properties: JmeterProperty[]): JmeterProperty[] {
  return properties
    .map((p) => ({ name: p.name.trim(), value: p.value }))
    .filter((p) => p.name)
}

export function appendJmeterPropertiesToForm(form: FormData, properties: JmeterProperty[]) {
  for (const prop of normalizeJmeterProperties(properties)) {
    form.append('property_names', prop.name)
    form.append('property_values', prop.value)
  }
}

export function jmeterPropertiesEqual(a: JmeterProperty[], b: JmeterProperty[]): boolean {
  const sa = normalizeJmeterProperties(a)
  const sb = normalizeJmeterProperties(b)
  if (sa.length !== sb.length) return false
  return sa.every((p, i) => p.name === sb[i].name && p.value === sb[i].value)
}

export function jmeterPropertiesForEditor(properties: JmeterProperty[] | undefined): JmeterProperty[] {
  const normalized = normalizeJmeterProperties(properties ?? [])
  return normalized.length > 0 ? normalized : [emptyJmeterProperty()]
}

interface JmeterPropertiesEditorProps {
  properties: JmeterProperty[]
  onChange: (properties: JmeterProperty[]) => void
  disabled?: boolean
  loading?: boolean
}

export default function JmeterPropertiesEditor({
  properties,
  onChange,
  disabled = false,
  loading = false,
}: JmeterPropertiesEditorProps) {
  const rows = properties.length > 0 ? properties : [emptyJmeterProperty()]

  function updateRow(index: number, field: keyof JmeterProperty, value: string) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  function addRow() {
    onChange([...rows, emptyJmeterProperty()])
  }

  function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index)
    onChange(next.length > 0 ? next : [emptyJmeterProperty()])
  }

  return (
    <div className="form-row">
      <label>JMeter properties</label>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: '0 0 0.5rem' }}>
        Name/value pairs passed as <code>-Jname=value</code> when the test runs. Use{' '}
        <code>${'{'}{'__P(name)'}{'}'}</code> or <code>${'{'}{'__property(name,,default)'}{'}'}</code> in your JMX.
      </p>
      {loading ? (
        <p className="modal-current-file">Loading properties…</p>
      ) : (
        <div className="jmeter-props-table">
          <div className="jmeter-props-header">
            <span>Property name</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div className="jmeter-props-row" key={index}>
              <input
                placeholder="e.g. load"
                value={row.name}
                onChange={(e) => updateRow(index, 'name', e.target.value)}
                disabled={disabled}
              />
              <input
                placeholder="e.g. 100"
                value={row.value}
                onChange={(e) => updateRow(index, 'value', e.target.value)}
                disabled={disabled}
              />
              <button
                type="button"
                className="file-picker-remove"
                onClick={() => removeRow(index)}
                disabled={disabled}
                aria-label="Remove property"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={addRow}
        disabled={disabled || loading}
        style={{ marginTop: '0.5rem' }}
      >
        Add property
      </button>
    </div>
  )
}

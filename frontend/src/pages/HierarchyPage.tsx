import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import FilePicker from '../components/FilePicker'
import JmeterPropertiesEditor, {
  appendJmeterPropertiesToForm,
  emptyJmeterProperty,
} from '../components/JmeterPropertiesEditor'
import StartRunModal from '../components/StartRunModal'
import TagInput from '../components/TagInput'
import { useToast } from '../components/Toast'
import { useActiveRuns } from '../context/ActiveRunsContext'
import { localInputToUtcIso, localTimezoneLabel } from '../utils/datetime'
import type { Application, Build, JmeterProperty, Release, Scenario } from '../types'

export default function HierarchyPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { refreshActivity } = useActiveRuns()
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedRelease, setSelectedRelease] = useState<Release | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [selectedBuild, setSelectedBuild] = useState<Build | null>(null)
  const [apps, setApps] = useState<Application[]>([])
  const [selectedApp, setSelectedApp] = useState<Application | null>(null)
  const [scenarios, setScenarios] = useState<Scenario[]>([])

  const [newRelease, setNewRelease] = useState('')
  const [newBuild, setNewBuild] = useState('')
  const [newApp, setNewApp] = useState('')
  const [newAppType, setNewAppType] = useState('')

  const [scenarioName, setScenarioName] = useState('')
  const [scenarioTags, setScenarioTags] = useState<string[]>([])
  const [jmxFiles, setJmxFiles] = useState<File[]>([])
  const [dependencyFiles, setDependencyFiles] = useState<File[]>([])
  const [jmeterProperties, setJmeterProperties] = useState<JmeterProperty[]>([emptyJmeterProperty()])
  const [scheduleAt, setScheduleAt] = useState('')
  const [startTarget, setStartTarget] = useState<{ id: number; name: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    api.listReleases().then(setReleases).catch(console.error)
  }, [])

  useEffect(() => {
    if (!selectedRelease) return
    api.listBuilds(selectedRelease.id).then(setBuilds).catch(console.error)
  }, [selectedRelease])

  useEffect(() => {
    if (!selectedBuild) return
    api.listApplications(selectedBuild.id).then(setApps).catch(console.error)
  }, [selectedBuild])

  useEffect(() => {
    if (!selectedApp) return
    api.listScenarios(selectedApp.id).then(setScenarios).catch(console.error)
  }, [selectedApp])

  async function addRelease() {
    if (!newRelease.trim()) return
    const r = await api.createRelease(newRelease.trim())
    setReleases((prev) => [r, ...prev])
    setNewRelease('')
  }

  async function addBuild() {
    if (!selectedRelease || !newBuild.trim()) return
    const b = await api.createBuild(selectedRelease.id, newBuild.trim())
    setBuilds((prev) => [b, ...prev])
    setNewBuild('')
  }

  async function addApp() {
    if (!selectedBuild || !newApp.trim()) return
    const a = await api.createApplication(selectedBuild.id, newApp.trim(), newAppType || undefined)
    setApps((prev) => [a, ...prev])
    setNewApp('')
    setNewAppType('')
  }

  async function uploadScenario() {
    if (!selectedApp || !jmxFiles[0] || !scenarioName.trim() || creating) return
    const nameForToast = scenarioName.trim()
    setCreating(true)
    toast.info(`Creating scenario "${nameForToast}"…`)
    try {
      const form = new FormData()
      form.append('name', scenarioName.trim())
      scenarioTags.forEach((t) => form.append('tags', t))
      form.append('jmx', jmxFiles[0])
      dependencyFiles.forEach((f) => form.append('dependencies', f))
      appendJmeterPropertiesToForm(form, jmeterProperties)
      const s = await api.createScenario(selectedApp.id, form)
      setScenarios((prev) => [s, ...prev])
      toast.success(`Scenario "${s.name}" created successfully`)
      setScenarioName('')
      setScenarioTags([])
      setJmxFiles([])
      setDependencyFiles([])
      setJmeterProperties([emptyJmeterProperty()])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create scenario')
    } finally {
      setCreating(false)
    }
  }

  async function runNow(description: string) {
    if (!startTarget) return
    const { id: scenarioId, name: nameForToast } = startTarget
    setStarting(true)
    try {
      toast.info(`Starting test for "${nameForToast}"…`)
      const run = await api.startTest(scenarioId, description)
      setStartTarget(null)
      void refreshActivity()
      if (run.status === 'failed') {
        toast.error(run.error_message || `Failed to start test (run #${run.id})`)
      } else if (run.status === 'pending') {
        toast.success(`Test queued (run #${run.id}) — view the Run Queue to manage`)
      } else {
        toast.success(`Test started (run #${run.id})`)
        navigate(`/live/${run.id}`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start test')
    } finally {
      setStarting(false)
    }
  }

  async function cloneScenario(scenarioId: number) {
    if (!selectedApp || creating) return
    setCreating(true)
    toast.info('Cloning scenario…')
    try {
      const cloned = await api.cloneScenario(scenarioId)
      toast.success(`Cloned as "${cloned.name}". Edit it from the Scenarios page to rename.`)
      const list = await api.listScenarios(selectedApp.id)
      setScenarios(list)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clone scenario')
    } finally {
      setCreating(false)
    }
  }

  async function schedule(scenarioId: number, scenarioName: string) {
    if (!scheduleAt) return
    try {
      await api.scheduleTest(scenarioId, localInputToUtcIso(scheduleAt))
      toast.success(`Test scheduled for "${scenarioName}". View it under Run Queue → Scheduled.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule test')
    }
  }

  return (
    <>
      <h1 className="page-title">Releases &amp; Scripts</h1>

      <div className="grid-3">
        <div className="card">
          <h2>Releases</h2>
          <div className="form-row">
            <input placeholder="Release name" value={newRelease} onChange={(e) => setNewRelease(e.target.value)} />
          </div>
          <button className="btn" onClick={addRelease}>Add Release</button>
          <ul style={{ marginTop: '0.75rem', listStyle: 'none' }}>
            {releases.map((r) => (
              <li key={r.id}>
                <button
                  className="btn-secondary btn"
                  style={{ width: '100%', marginTop: '0.25rem', justifyContent: 'flex-start' }}
                  onClick={() => { setSelectedRelease(r); setSelectedBuild(null); setSelectedApp(null) }}
                >
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Builds {selectedRelease && `— ${selectedRelease.name}`}</h2>
          {selectedRelease && (
            <>
              <div className="form-row">
                <input placeholder="Build name" value={newBuild} onChange={(e) => setNewBuild(e.target.value)} />
              </div>
              <button className="btn" onClick={addBuild}>Add Build</button>
            </>
          )}
          <ul style={{ marginTop: '0.75rem', listStyle: 'none' }}>
            {builds.map((b) => (
              <li key={b.id}>
                <button
                  className="btn-secondary btn"
                  style={{ width: '100%', marginTop: '0.25rem', justifyContent: 'flex-start' }}
                  onClick={() => { setSelectedBuild(b); setSelectedApp(null) }}
                >
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Applications {selectedBuild && `— ${selectedBuild.name}`}</h2>
          {selectedBuild && (
            <>
              <div className="form-row">
                <input placeholder="Application name" value={newApp} onChange={(e) => setNewApp(e.target.value)} />
              </div>
              <div className="form-row">
                <input placeholder="Type (e.g. Web, API)" value={newAppType} onChange={(e) => setNewAppType(e.target.value)} />
              </div>
              <button className="btn" onClick={addApp}>Add Application</button>
            </>
          )}
          <ul style={{ marginTop: '0.75rem', listStyle: 'none' }}>
            {apps.map((a) => (
              <li key={a.id}>
                <button
                  className="btn-secondary btn"
                  style={{ width: '100%', marginTop: '0.25rem', justifyContent: 'flex-start' }}
                  onClick={() => setSelectedApp(a)}
                >
                  {a.name} {a.app_type && <span style={{ color: 'var(--muted)' }}>({a.app_type})</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {selectedApp && (
        <>
          <div className="card">
            <h2>Upload Scenario — {selectedApp.name}</h2>
            {creating && (
              <div className="scenario-create-busy" role="status" aria-live="polite">
                <span className="dashboard-results-spinner" aria-hidden="true" />
                <div>
                  <strong>Creating scenario…</strong>
                  <span>Uploading JMX and dependencies. Please wait — do not click again.</span>
                </div>
              </div>
            )}
            <fieldset disabled={creating} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="grid-2">
              <div className="form-row">
                <label>Scenario name</label>
                <input value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} />
              </div>
              <div className="form-row">
                <label>Tags</label>
                <TagInput tags={scenarioTags} onChange={setScenarioTags} />
              </div>
            </div>
            <div className="grid-2">
              <FilePicker
                label="JMX script"
                buttonText="Select JMX file"
                accept=".jmx"
                files={jmxFiles}
                onChange={setJmxFiles}
                emptyText="No JMX file selected"
              />
              <FilePicker
                label="Script dependencies (CSV and other files)"
                buttonText="Select CSV / dependency files"
                accept=".csv,.txt,.json,.xml,.properties,.dat"
                multiple
                files={dependencyFiles}
                onChange={setDependencyFiles}
                emptyText="No dependency files selected"
              />
            </div>
            <JmeterPropertiesEditor properties={jmeterProperties} onChange={setJmeterProperties} />
            <button
              className="btn"
              onClick={() => void uploadScenario()}
              disabled={creating || jmxFiles.length === 0 || !scenarioName.trim()}
              title={
                creating
                  ? 'Creating scenario…'
                  : jmxFiles.length === 0
                    ? 'Select a JMX file first'
                    : !scenarioName.trim()
                      ? 'Enter a scenario name'
                      : undefined
              }
            >
              {creating ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                'Upload Scenario'
              )}
            </button>
            </fieldset>
          </div>

          <div className="card">
            <h2>Scenarios</h2>
            {scenarios.length === 0 ? (
              <p className="empty">No scenarios yet</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Tags</th>
                    <th>JMX</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>
                        {(s.tags && s.tags.length > 0) ? (
                          <span className="tag-list">
                            {s.tags.map((tag) => (
                              <span key={tag} className="tag-chip tag-chip-readonly">{tag}</span>
                            ))}
                          </span>
                        ) : '—'}
                      </td>
                      <td>{s.jmx_filename}</td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ marginRight: '0.5rem' }}
                          disabled={creating}
                          onClick={() => void cloneScenario(s.id)}
                        >
                          {creating ? 'Working…' : 'Clone'}
                        </button>
                        <button className="btn" style={{ marginRight: '0.5rem' }} onClick={() => setStartTarget({ id: s.id, name: s.name })}>Run Test</button>
                        <input
                          type="datetime-local"
                          value={scheduleAt}
                          onChange={(e) => setScheduleAt(e.target.value)}
                          title={`Local time (${localTimezoneLabel()})`}
                          style={{ width: 'auto', display: 'inline-block', marginRight: '0.5rem' }}
                        />
                        <button className="btn btn-secondary" onClick={() => schedule(s.id, s.name)}>Schedule</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <StartRunModal
        open={Boolean(startTarget)}
        scenarioName={startTarget?.name ?? ''}
        submitting={starting}
        onClose={() => {
          if (!starting) setStartTarget(null)
        }}
        onConfirm={runNow}
      />
    </>
  )
}

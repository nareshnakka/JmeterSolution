import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import FilePicker from '../components/FilePicker'
import TagInput from '../components/TagInput'
import { useToast } from '../components/Toast'
import type { Application, Build, Release, Scenario } from '../types'

export default function HierarchyPage() {
  const navigate = useNavigate()
  const toast = useToast()
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
  const [scheduleAt, setScheduleAt] = useState('')

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
    if (!selectedApp || !jmxFiles[0] || !scenarioName.trim()) return
    const form = new FormData()
    form.append('name', scenarioName)
    scenarioTags.forEach((t) => form.append('tags', t))
    form.append('jmx', jmxFiles[0])
    dependencyFiles.forEach((f) => form.append('dependencies', f))
    const s = await api.createScenario(selectedApp.id, form)
    setScenarios((prev) => [s, ...prev])
    toast.success(`Scenario "${s.name}" uploaded successfully`)
    setScenarioName('')
    setScenarioTags([])
    setJmxFiles([])
    setDependencyFiles([])
  }

  async function runNow(scenarioId: number, scenarioName: string) {
    try {
      toast.info(`Starting test for "${scenarioName}"…`)
      const run = await api.startTest(scenarioId)
      toast.success(`Test started (run #${run.id})`)
      navigate(`/live/${run.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start test')
    }
  }

  async function schedule(scenarioId: number, scenarioName: string) {
    if (!scheduleAt) return
    try {
      await api.scheduleTest(scenarioId, new Date(scheduleAt).toISOString())
      toast.success(`Test scheduled for "${scenarioName}"`)
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
            <button className="btn" onClick={uploadScenario}>Upload Scenario</button>
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
                        <button className="btn" style={{ marginRight: '0.5rem' }} onClick={() => runNow(s.id, s.name)}>Run Now</button>
                        <input
                          type="datetime-local"
                          value={scheduleAt}
                          onChange={(e) => setScheduleAt(e.target.value)}
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
    </>
  )
}

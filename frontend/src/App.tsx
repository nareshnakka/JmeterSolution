import { NavLink, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import HierarchyPage from './pages/HierarchyPage'
import ScenariosPage from './pages/ScenariosPage'
import TestRunsPage from './pages/TestRunsPage'
import QueuePage from './pages/QueuePage'
import LiveDashboard from './pages/LiveDashboard'
import ComparePage from './pages/ComparePage'
import ConfigPage from './pages/ConfigPage'

export default function App() {
  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-brand">
            <span className="app-brand-mark" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L2 7l10 5 10-5-10-5zm0 8.5L4.5 7.5 12 4l7.5 3.5L12 10.5zm-8 3.5l8 4.5 8-4.5v3L12 19 4 16v-3z" />
              </svg>
            </span>
            <div>
              <div className="app-brand-name">JMeter Agent</div>
              <div className="app-brand-tagline">Performance Test Management</div>
            </div>
          </div>
        </header>
        <div className="layout">
          <aside className="sidebar">
            <nav className="sidebar-nav">
              <NavLink to="/" end>Releases &amp; Scripts</NavLink>
              <NavLink to="/scenarios">All Scenarios</NavLink>
              <NavLink to="/queue">Run Queue</NavLink>
              <NavLink to="/runs">Test Runs</NavLink>
              <NavLink to="/compare">Compare</NavLink>
              <NavLink to="/config">Configuration</NavLink>
            </nav>
          </aside>
          <main className="main">
            <Routes>
              <Route path="/" element={<HierarchyPage />} />
              <Route path="/scenarios" element={<ScenariosPage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/runs" element={<TestRunsPage />} />
              <Route path="/live/:runId" element={<LiveDashboard />} />
              <Route path="/compare" element={<ComparePage />} />
              <Route path="/config" element={<ConfigPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}

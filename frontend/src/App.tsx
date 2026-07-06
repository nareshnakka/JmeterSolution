import { NavLink, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import HierarchyPage from './pages/HierarchyPage'
import ScenariosPage from './pages/ScenariosPage'
import TestRunsPage from './pages/TestRunsPage'
import LiveDashboard from './pages/LiveDashboard'
import ComparePage from './pages/ComparePage'

export default function App() {
  return (
    <ToastProvider>
    <div className="layout">
      <aside className="sidebar">
        <h1>JMeter Agent</h1>
        <nav>
          <NavLink to="/" end>Releases &amp; Scripts</NavLink>
          <NavLink to="/scenarios">All Scenarios</NavLink>
          <NavLink to="/runs">Test Runs</NavLink>
          <NavLink to="/compare">Compare</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HierarchyPage />} />
          <Route path="/scenarios" element={<ScenariosPage />} />
          <Route path="/runs" element={<TestRunsPage />} />
          <Route path="/live/:runId" element={<LiveDashboard />} />
          <Route path="/compare" element={<ComparePage />} />
        </Routes>
      </main>
    </div>
    </ToastProvider>
  )
}

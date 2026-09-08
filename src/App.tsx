import { Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AboutPage } from './pages/AboutPage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { ParentsPage } from './pages/ParentsPage'

const LabPage = lazy(() => import('./lab/LabPage').then((m) => ({ default: m.LabPage })))

export const App = () => (
  <Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/play/:id" element={<GamePage />} />
    <Route path="/parents" element={<ParentsPage />} />
    <Route path="/about" element={<AboutPage />} />
    <Route
      path="/lab/:model"
      element={
        <Suspense fallback={<p style={{ padding: '1rem', fontFamily: 'monospace' }}>Loading lab…</p>}>
          <LabPage />
        </Suspense>
      }
    />
    <Route path="*" element={<HomePage />} />
  </Routes>
)

export default App

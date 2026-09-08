import { Route, Routes } from 'react-router-dom'
import { AboutPage } from './pages/AboutPage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { ParentsPage } from './pages/ParentsPage'

export const App = () => (
  <Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/play/:id" element={<GamePage />} />
    <Route path="/parents" element={<ParentsPage />} />
    <Route path="/about" element={<AboutPage />} />
    <Route path="*" element={<HomePage />} />
  </Routes>
)

export default App

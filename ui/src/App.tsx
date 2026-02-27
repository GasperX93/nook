import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Drive from './pages/Drive'
import Logs from './pages/Logs'
import Publish from './pages/Publish'
import Settings from './pages/Settings'
import Wallet from './pages/Wallet'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/publish" replace />} />
        <Route path="publish" element={<Publish />} />
        <Route path="drive" element={<Drive />} />
        <Route path="wallet" element={<Wallet />} />
        <Route path="settings" element={<Settings />} />
        <Route path="logs" element={<Logs />} />
      </Route>
    </Routes>
  )
}

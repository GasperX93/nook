import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Account from './pages/Account'
import Contacts from './pages/Contacts'
import Dev from './pages/Dev'
import Drive from './pages/Drive'
import Settings from './pages/Settings'
import WebsitePublisher from './apps/WebsitePublisher'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/drive" replace />} />
        <Route path="drive" element={<Drive />} />
        <Route path="wallet" element={<Navigate to="/account" replace />} />
        <Route path="account" element={<Account />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="settings" element={<Settings />} />
        <Route path="logs" element={<Navigate to="/dev" replace />} />
        <Route path="dev" element={<Dev />} />
        <Route path="apps/website-publisher" element={<WebsitePublisher />} />
      </Route>
    </Routes>
  )
}

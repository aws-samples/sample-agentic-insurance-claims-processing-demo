import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, type ReactNode } from 'react'
import { useAuthStore } from './stores/authStore'
import Login from './pages/Auth/Login'
import ClaimantPortal from './pages/ClaimantPortal/ClaimantPortal'
import AdjusterWorkbench from './pages/AdjusterWorkbench/AdjusterWorkbench'
import BusinessDashboard from './pages/BusinessDashboard/BusinessDashboard'
import Layout from './components/Layout/Layout'
import ChatWidget from './components/ChatWidget/ChatWidget'

/** Only renders children if the user belongs to one of the allowed roles */
function RoleGuard({ allowed, children }: { allowed: string[]; children: ReactNode }) {
  const { user } = useAuthStore()
  if (!user || !allowed.includes(user.role)) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

function App() {
  const { isAuthenticated, user, checkAuth } = useAuthStore()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  if (!isAuthenticated) {
    return <Login />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to={getDefaultRoute(user?.role)} replace />} />
        <Route path="/claimant/*" element={
          <RoleGuard allowed={['Claimants']}>
            <ClaimantPortal />
          </RoleGuard>
        } />
        <Route path="/adjuster/*" element={
          <RoleGuard allowed={['Adjusters']}>
            <AdjusterWorkbench />
          </RoleGuard>
        } />
        <Route path="/dashboard/*" element={
          <RoleGuard allowed={['BusinessUsers']}>
            <BusinessDashboard />
          </RoleGuard>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {user?.role === 'Claimants' && <ChatWidget />}
    </Layout>
  )
}

function getDefaultRoute(role?: string): string {
  switch (role) {
    case 'Adjusters':
      return '/adjuster'
    case 'BusinessUsers':
      return '/dashboard'
    case 'Claimants':
    default:
      return '/claimant'
  }
}

export default App

import { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import {
  FileText,
  LayoutDashboard,
  ClipboardCheck,
  LogOut,
  Shield,
} from 'lucide-react'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/', { replace: true })
  }

  const navigation = [
    {
      name: 'Claimant Portal',
      href: '/claimant',
      icon: FileText,
      roles: ['Claimants'],
    },
    {
      name: 'Adjuster Workbench',
      href: '/adjuster',
      icon: ClipboardCheck,
      roles: ['Adjusters'],
    },
    {
      name: 'Business Dashboard',
      href: '/dashboard',
      icon: LayoutDashboard,
      roles: ['BusinessUsers'],
    },
  ]

  const filteredNav = navigation.filter((item) =>
    item.roles.includes(user?.role || '')
  )

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-gradient-to-r from-primary-800 via-primary-700 to-primary-900 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <div className="bg-white/10 rounded-lg p-2">
                <Shield className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-white tracking-tight">
                  CCOE Insurance Industry LLC
                </h1>
                <p className="text-primary-200 text-xs">
                  Death Benefits Claims Processing
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <p className="text-sm text-white font-medium">{user?.email}</p>
                <p className="text-xs text-primary-200">{user?.role}</p>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-primary-200 hover:text-white 
                           bg-white/10 hover:bg-white/20 px-3 py-2 rounded-lg transition-all duration-200"
                aria-label="Logout"
              >
                <LogOut className="h-4 w-4" />
                <span className="text-sm hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-1">
            {filteredNav.map((item) => {
              const Icon = item.icon
              const isActive = location.pathname.startsWith(item.href)
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 transition-all duration-200
                    ${
                      isActive
                        ? 'border-primary-600 text-primary-700 bg-primary-50/50'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                    }
                  `}
                >
                  <Icon className="h-4 w-4" />
                  {item.name}
                </Link>
              )
            })}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 py-8">
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-400">
              © 2026 CCOE Insurance Industry LLC
            </p>
            <p className="text-sm text-gray-400 flex items-center gap-1.5">
              Powered by
              <span className="font-medium text-gray-500">Amazon Bedrock AgentCore</span>
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

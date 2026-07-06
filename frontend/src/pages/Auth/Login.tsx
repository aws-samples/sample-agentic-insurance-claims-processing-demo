import { useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { AlertCircle } from 'lucide-react'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { login, isLoading, error } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await login(username, password)
    } catch (err) {
      // Error is handled by the store
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            CCOE Insurance Industry LLC
          </h1>
          <p className="text-gray-600">AI-Powered Claims Processing</p>
        </div>

        <div className="card">
          <h2 className="text-2xl font-semibold text-gray-900 mb-6">Sign In</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email or Username</label>
              <input
                type="text"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your email"
                required
                autoFocus
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={isLoading}
            >
              {isLoading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-sm text-gray-600 text-center">
              Demo Test Users:
            </p>
            <div className="mt-2 space-y-1 text-xs text-gray-500">
              <p>Claimant: claimant1 / Test123!</p>
              <p>Adjuster: adjuster1 / Test123!</p>
              <p>Business: business1 / Test123!</p>
            </div>
          </div>
        </div>

        <p className="text-center text-sm text-gray-600 mt-4">
          AI-Powered Claims Processing | Amazon Bedrock AgentCore
        </p>
      </div>
    </div>
  )
}

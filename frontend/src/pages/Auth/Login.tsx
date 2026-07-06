import { useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { AlertCircle, Shield, Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const { login, confirmMfa, isLoading, error, mfaStep, totpSecretKey, totpSetupUri, clearError } = useAuthStore()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    await login(username, password)
  }

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (totpCode.length === 6) {
      await confirmMfa(totpCode)
    }
  }

  // TOTP Setup screen (first-time enrollment)
  if (mfaStep === 'TOTP_SETUP') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="card">
            <div className="flex items-center gap-3 mb-6">
              <Shield className="h-8 w-8 text-primary-600" />
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Set Up Two-Factor Authentication</h2>
                <p className="text-sm text-gray-600">Required for account security</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-800 font-medium mb-2">Steps:</p>
                <ol className="text-sm text-blue-700 space-y-1 list-decimal list-inside">
                  <li>Open your authenticator app (Google Authenticator, Authy, 1Password)</li>
                  <li>Add a new account using the key below</li>
                  <li>Enter the 6-digit code from the app</li>
                </ol>
              </div>

              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex justify-center mb-3">
                  {totpSetupUri && (
                    <QRCodeSVG value={totpSetupUri} size={200} level="M" />
                  )}
                </div>
                <p className="text-xs text-gray-500 text-center">Scan this QR code with your authenticator app</p>
                <details className="mt-3">
                  <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
                    Can't scan? Enter key manually
                  </summary>
                  <code className="text-xs font-mono text-gray-700 break-all select-all block mt-2">
                    {totpSecretKey}
                  </code>
                </details>
              </div>

              <form onSubmit={handleMfaSubmit} className="space-y-4">
                <div>
                  <label className="label">Verification Code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="input text-center text-2xl tracking-widest font-mono"
                    value={totpCode}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '')
                      setTotpCode(val)
                      clearError()
                    }}
                    placeholder="000000"
                    required
                    autoFocus
                  />
                  <p className="text-xs text-gray-500 mt-1">Enter the 6-digit code from your authenticator app</p>
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
                  disabled={isLoading || totpCode.length !== 6}
                >
                  {isLoading ? 'Verifying...' : 'Complete Setup'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // TOTP Code entry screen (subsequent logins)
  if (mfaStep === 'TOTP_CODE') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="card">
            <div className="flex items-center gap-3 mb-6">
              <Smartphone className="h-8 w-8 text-primary-600" />
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Two-Factor Authentication</h2>
                <p className="text-sm text-gray-600">Enter the code from your authenticator app</p>
              </div>
            </div>

            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <div>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  className="input text-center text-2xl tracking-widest font-mono"
                  value={totpCode}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '')
                    setTotpCode(val)
                    clearError()
                  }}
                  placeholder="000000"
                  required
                  autoFocus
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
                disabled={isLoading || totpCode.length !== 6}
              >
                {isLoading ? 'Verifying...' : 'Verify'}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // Normal login screen
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

          <form onSubmit={handleLogin} className="space-y-4">
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
              <p>Claimant: claimant1 / Test123!Pass</p>
              <p>Adjuster: adjuster1 / Test123!Pass</p>
              <p>Business: business1 / Test123!Pass</p>
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

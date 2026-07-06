import { create } from 'zustand'
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  confirmSignIn,
} from 'aws-amplify/auth'

interface User {
  username: string
  email: string
  role: string
  groups: string[]
}

type MfaStep =
  | null
  | 'TOTP_SETUP'
  | 'TOTP_CODE'

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  mfaStep: MfaStep
  totpSetupUri: string | null
  totpSecretKey: string | null
  login: (username: string, password: string) => Promise<void>
  confirmMfa: (code: string) => Promise<void>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  mfaStep: null,
  totpSetupUri: null,
  totpSecretKey: null,

  login: async (username: string, password: string) => {
    try {
      set({ isLoading: true, error: null, mfaStep: null, totpSetupUri: null, totpSecretKey: null })

      try { await signOut() } catch (_) { /* ignore */ }

      const signInResult = await signIn({ username, password })
      const nextStep = signInResult.nextStep?.signInStep

      if (nextStep === 'CONFIRM_SIGN_UP') {
        set({ error: 'Account not confirmed. Please contact admin.', isLoading: false })
        return
      }

      if (nextStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const setupDetails = signInResult.nextStep?.totpSetupDetails
        const secretKey = setupDetails?.sharedSecret || ''
        const setupUri = setupDetails?.getSetupUri('CCOEInsurance', username)?.toString() || ''

        set({
          mfaStep: 'TOTP_SETUP',
          totpSecretKey: secretKey,
          totpSetupUri: setupUri,
          isLoading: false,
        })
        return
      }

      if (nextStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        set({ mfaStep: 'TOTP_CODE', isLoading: false })
        return
      }

      if (nextStep === 'DONE' || signInResult.isSignedIn) {
        await get().checkAuth()
        return
      }

      set({
        error: `Unexpected auth step: ${nextStep || 'unknown'}`,
        isLoading: false,
      })
    } catch (error: any) {
      set({
        error: error.message || 'Login failed. Please check your credentials.',
        isLoading: false,
      })
    }
  },

  confirmMfa: async (code: string) => {
    try {
      set({ isLoading: true, error: null })

      const result = await confirmSignIn({ challengeResponse: code })

      if (result.isSignedIn || result.nextStep?.signInStep === 'DONE') {
        set({ mfaStep: null, totpSetupUri: null, totpSecretKey: null })
        await get().checkAuth()
      } else {
        set({
          error: `Unexpected step after MFA: ${result.nextStep?.signInStep}`,
          isLoading: false,
        })
      }
    } catch (error: any) {
      set({
        error: error.message || 'Invalid verification code. Please try again.',
        isLoading: false,
      })
    }
  },

  logout: async () => {
    try {
      await signOut({ global: true })
    } catch (_) { /* ignore */ }
    finally {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        mfaStep: null,
        totpSetupUri: null,
        totpSecretKey: null,
      })
    }
  },

  checkAuth: async () => {
    try {
      set({ isLoading: true })

      const currentUser = await getCurrentUser()
      const session = await fetchAuthSession()

      const groups = session.tokens?.accessToken?.payload['cognito:groups'] as string[] || []
      const role = groups[0] || 'Claimants'

      set({
        user: {
          username: currentUser.username,
          email: currentUser.signInDetails?.loginId || '',
          role,
          groups,
        },
        isAuthenticated: true,
        isLoading: false,
        mfaStep: null,
      })
    } catch (error) {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      })
    }
  },

  clearError: () => set({ error: null }),
}))

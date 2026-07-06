import { create } from 'zustand'
import { signIn, signOut, getCurrentUser, fetchAuthSession } from 'aws-amplify/auth'

interface User {
  username: string
  email: string
  role: string
  groups: string[]
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (username: string, password: string) => {
    try {
      set({ isLoading: true, error: null })

      // Clear any stale Amplify sign-in session before attempting
      try { await signOut() } catch (_) { /* ignore */ }
      
      const signInResult = await signIn({ username, password })

      if (signInResult.nextStep?.signInStep === 'CONFIRM_SIGN_UP') {
        set({ error: 'Account not confirmed. Please contact admin.', isLoading: false })
        return
      }

      if (signInResult.nextStep?.signInStep === 'DONE' || signInResult.isSignedIn) {
        const currentUser = await getCurrentUser()
        const session = await fetchAuthSession()
        
        const groups = session.tokens?.accessToken?.payload['cognito:groups'] as string[] || []
        const role = groups[0] || 'Claimants'
        
        set({
          user: {
            username: currentUser.username,
            email: currentUser.signInDetails?.loginId || username,
            role,
            groups,
          },
          isAuthenticated: true,
          isLoading: false,
        })
      } else {
        set({
          error: `Additional step required: ${signInResult.nextStep?.signInStep || 'unknown'}`,
          isLoading: false,
        })
      }
    } catch (error: any) {
      set({
        error: error.message || 'Login failed. Please check your credentials.',
        isLoading: false,
      })
    }
  },

  logout: async () => {
    try {
      await signOut({ global: true })
    } catch (_) {
      /* ignore signOut errors */
    } finally {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
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
      })
    } catch (error) {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      })
    }
  },
}))

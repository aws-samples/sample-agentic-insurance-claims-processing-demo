import axios from 'axios'
import { fetchAuthSession } from 'aws-amplify/auth'

const API_URL = import.meta.env.VITE_API_URL

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Add auth token to requests
api.interceptors.request.use(async (config) => {
  try {
    const session = await fetchAuthSession({ forceRefresh: false })
    const token = session.tokens?.idToken?.toString()
    
    if (token) {
      config.headers.Authorization = token
    }
  } catch (error) {
    console.error('Failed to get auth token:', error)
  }
  
  return config
})

// Claims API
export const claimsApi = {
  // Submit new claim
  submitClaim: async (claimData: any) => {
    const response = await api.post('/claims', claimData)
    return response.data
  },

  // Get all claims (with optional filters)
  getClaims: async (filters?: any) => {
    const response = await api.get('/claims', { params: filters })
    return response.data
  },

  // Get single claim
  getClaim: async (claimId: string) => {
    const response = await api.get(`/claims/${claimId}`)
    return response.data
  },

  // Update claim
  updateClaim: async (claimId: string, updates: any) => {
    const response = await api.put(`/claims/${claimId}`, updates)
    return response.data
  },

  // Approve claim (adjuster only)
  approveClaim: async (claimId: string, notes: string) => {
    const response = await api.post(`/claims/${claimId}/approve`, { notes })
    return response.data
  },

  // Deny claim (adjuster only)
  denyClaim: async (claimId: string, reason: string) => {
    const response = await api.post(`/claims/${claimId}/deny`, { reason })
    return response.data
  },

  // Resubmit claim with additional info/documents (claimant)
  resubmitClaim: async (claimId: string, data: { notes?: string; causeOfDeath?: string; relationship?: string; additionalNotes?: string }) => {
    const response = await api.post(`/claims/${claimId}/resubmit`, data)
    return response.data
  },

  // Reset demo — clears all claims and documents
  resetDemo: async () => {
    const response = await api.post('/reset')
    return response.data
  },

  // Upload documents (multiple files as base64 JSON)
  uploadDocuments: async (claimId: string, files: File[]) => {
    const documents = await Promise.all(
      files.map(async (file) => {
        const base64 = await fileToBase64(file)
        return {
          fileName: file.name,
          fileContent: base64,
          documentType: guessDocType(file.name),
        }
      })
    )

    const response = await api.post(`/claims/${claimId}/documents`, { documents })
    return response.data
  },

  // Get documents
  getDocuments: async (claimId: string) => {
    const response = await api.get(`/claims/${claimId}/documents`)
    return response.data
  },
}

// Metrics API
export const metricsApi = {
  // Get dashboard metrics
  getDashboardMetrics: async () => {
    const response = await api.get('/metrics/dashboard')
    return response.data
  },

  // Get claims breakdown
  getClaimsBreakdown: async () => {
    const response = await api.get('/metrics/breakdown')
    return response.data
  },
}

// Chat API
export const chatApi = {
  sendMessage: async (message: string, history: { role: string; content: string }[] = []) => {
    const response = await api.post('/chat', { message, history })
    return response.data
  },
}

export default api

// Helper: convert File to base64 string (without data URI prefix)
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the "data:...;base64," prefix
      const base64 = result.split(',')[1] || result
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Helper: guess document type from filename
function guessDocType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('death_cert') || lower.includes('death-cert')) return 'death_certificate'
  if (lower.includes('medical') || lower.includes('hospital') || lower.includes('discharge')) return 'medical_records'
  if (lower.includes('policy')) return 'policy_document'
  if (lower.includes('beneficiary') || lower.includes('license') || lower.includes('_id')) return 'beneficiary_id'
  if (lower.includes('trust')) return 'trust_document'
  if (lower.includes('police')) return 'police_report'
  return 'other'
}

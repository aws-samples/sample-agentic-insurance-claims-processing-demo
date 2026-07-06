export interface Claim {
  claimId: string
  policyNumber: string
  policyHolderName: string
  beneficiaryId: string
  beneficiaryName: string
  relationship: string
  dateOfDeath: string
  causeOfDeath: string
  claimAmount: number
  status: ClaimStatus
  submittedAt: number
  updatedAt: number
  documents: Document[]
  processingDetails?: ProcessingDetails
  fraudScore?: number
  adjudicationNotes?: string
}

export type ClaimStatus =
  | 'submitted'
  | 'authenticating'
  | 'extracting'
  | 'verifying_policy'
  | 'fraud_check'
  | 'adjudicating'
  | 'approved'
  | 'denied'
  | 'pending_review'
  | 'pending_documents'

export interface Document {
  documentId: string
  documentType: DocumentType
  fileName: string
  uploadedAt: number
  s3Key: string
  extractedData?: any
}

export type DocumentType =
  | 'death_certificate'
  | 'medical_records'
  | 'policy_document'
  | 'beneficiary_id'
  | 'claim_form'
  | 'autopsy_report'
  | 'police_report'
  | 'other'

export interface ProcessingDetails {
  authenticationResult?: {
    authenticated: boolean
    confidenceScore: number
    concerns: string[]
  }
  extractionResult?: {
    completenessScore: number
    missingFields: string[]
  }
  policyVerificationResult?: {
    policyActive: boolean
    coverageAmount: number
    exclusions: string[]
  }
  fraudDetectionResult?: {
    riskScore: number
    indicators: string[]
  }
  adjudicationResult?: {
    decision: 'approve' | 'deny' | 'review'
    reasoning: string
    payoutAmount?: number
  }
}

export interface DashboardMetrics {
  totalClaims: number
  autoApproved: number
  autoDenied: number
  pendingReview: number
  averageProcessingTime: number
  totalPayout: number
  fraudDetected: number
  claimsByStatus: Record<ClaimStatus, number>
  claimsByMonth: Array<{ month: string; count: number }>
  averageCostPerClaim: number
}

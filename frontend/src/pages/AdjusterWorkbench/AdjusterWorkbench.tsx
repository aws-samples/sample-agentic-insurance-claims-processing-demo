import { useState, useEffect, useRef } from 'react'
import { claimsApi } from '@/services/api'
import {
  ClipboardCheck, CheckCircle, XCircle, Brain, Loader2, FileSearch,
  FileText, UserCheck, Database, Globe, Shield, Search, Scale,
  ChevronLeft, ChevronRight, Paperclip, AlertTriangle, RotateCcw
} from 'lucide-react'

// ── Processing Flow Step Definitions ──────────────────────────────────

interface FlowStep {
  id: string
  label: string
  agent: string
  icon: any
  description: string
  toolCall?: string
}

const FLOW_STEPS: FlowStep[] = [
  {
    id: 'claim_received',
    label: 'Claim Received',
    agent: 'System',
    icon: FileText,
    description: 'Claim submitted and recorded in the system.',
  },
  {
    id: 'document_verification',
    label: 'Document Verification',
    agent: 'Extractor Agent',
    icon: FileSearch,
    description: 'AI reads and cross-references all uploaded documents — death certificate, medical records, policy documents, beneficiary ID.',
  },
  {
    id: 'death_registry_lookup',
    label: 'Death Registry Lookup',
    agent: 'Authenticator Agent',
    icon: Database,
    description: 'Queries the National Death Registry (NDI) to verify the death record matches the certificate.',
  },
  {
    id: 'obituary_search',
    label: 'Obituary & Public Records',
    agent: 'Authenticator Agent',
    icon: Globe,
    description: 'Searches public obituary databases, funeral home listings, and news sources to corroborate the death.',
  },
  {
    id: 'beneficiary_auth',
    label: 'Beneficiary Authentication',
    agent: 'Authenticator Agent',
    icon: UserCheck,
    description: 'Validates beneficiary identity against policy records. Checks ID documents, relationship, and designation history.',
  },
  {
    id: 'policy_verification',
    label: 'Policy Verification',
    agent: 'Policy Verification Agent',
    icon: Shield,
    description: 'Checks policy status (active/lapsed), premium payments, coverage amount, exclusions, and contestability period.',
  },
  {
    id: 'fraud_analysis',
    label: 'Fraud Analysis',
    agent: 'Fraud Detection Agent',
    icon: Search,
    description: 'Calculates fraud risk score based on timing patterns, beneficiary changes, coverage increases, and historical fraud data.',
  },
  {
    id: 'adjudication',
    label: 'Adjudication Decision',
    agent: 'Adjudication Agent',
    icon: Scale,
    description: 'Makes final decision based on all agent outputs. Applies regulatory rules and company policy thresholds.',
  },
]

// ── Dynamic tool call labels based on processing path ─────────────────

const TOOL_CALLS: Record<string, Record<string, string>> = {
  agentcore: {
    document_verification: 'agentcore:ExtractorAgent → Analyze document content',
    death_registry_lookup: 'agentcore:AuthenticatorAgent → mcp:death_registry.verify_record',
    obituary_search: 'agentcore:AuthenticatorAgent → mcp:web_search.find_obituary',
    beneficiary_auth: 'agentcore:AuthenticatorAgent → mcp:identity_verification.validate',
    policy_verification: 'agentcore:PolicyVerificationAgent → knowledge_base:policy-guidelines',
    fraud_analysis: 'agentcore:FraudDetectionAgent → knowledge_base:fraud-patterns',
    adjudication: 'agentcore:AdjudicationAgent → knowledge_base:regulatory',
  },
  bedrock_direct: {
    document_verification: 'bedrock:InvokeModel → Direct document analysis',
    death_registry_lookup: 'bedrock:InvokeModel → Direct registry check',
    obituary_search: 'bedrock:InvokeModel → Direct public records search',
    beneficiary_auth: 'bedrock:InvokeModel → Direct identity validation',
    policy_verification: 'bedrock:InvokeModel → Direct policy lookup',
    fraud_analysis: 'bedrock:InvokeModel → Direct fraud scoring',
    adjudication: 'bedrock:InvokeModel → Direct adjudication',
  },
}

function getToolCall(stepId: string, processingPath: string | null): string | undefined {
  if (!processingPath) return undefined
  return TOOL_CALLS[processingPath]?.[stepId]
}

// ── Helper: determine step status from claim data ─────────────────────

type StepStatus = 'completed' | 'active' | 'pending' | 'failed'

interface StepInfo { status: StepStatus; detail?: string }
interface StepStatusResult {
  steps: Record<string, StepInfo>
  processingPath: string | null
}

function getStepStatuses(claim: any): StepStatusResult {
  const status = (claim.status || '').toLowerCase()

  let details: any = {}
  if (claim.processingDetails) {
    try {
      details = typeof claim.processingDetails === 'string'
        ? JSON.parse(claim.processingDetails) : claim.processingDetails
    } catch { /* ignore */ }
  }

  const processingPath: string | null = details.processing_path || null
  const fraudScore = details.fraud_score ?? null
  const policyValid = details.policy_valid ?? null
  const authPassed = details.authentication_passed ?? null
  const docsVerified = details.documents_verified ?? null
  const docFindings = details.document_findings || null
  const decision = details.decision || status

  if (status === 'submitted') {
    return {
      processingPath,
      steps: {
        claim_received: { status: 'completed', detail: 'Claim recorded' },
        document_verification: { status: 'pending' },
        death_registry_lookup: { status: 'pending' },
        obituary_search: { status: 'pending' },
        beneficiary_auth: { status: 'pending' },
        policy_verification: { status: 'pending' },
        fraud_analysis: { status: 'pending' },
        adjudication: { status: 'pending' },
      },
    }
  }

  if (status === 'processing') {
    return {
      processingPath,
      steps: {
        claim_received: { status: 'completed', detail: 'Claim recorded' },
        document_verification: { status: 'active', detail: 'Analyzing documents...' },
        death_registry_lookup: { status: 'active', detail: 'Querying registry...' },
        obituary_search: { status: 'active', detail: 'Searching public records...' },
        beneficiary_auth: { status: 'pending' },
        policy_verification: { status: 'pending' },
        fraud_analysis: { status: 'pending' },
        adjudication: { status: 'pending' },
      },
    }
  }

  const isFailed = decision === 'denied'

  // Deterministic escalation (no AI was invoked — doc check caught it)
  if (!processingPath && docsVerified === false) {
    return {
      processingPath,
      steps: {
        claim_received: { status: 'completed', detail: 'Claim recorded' },
        document_verification: {
          status: 'failed',
          detail: docFindings ? docFindings.substring(0, 120) : 'Required documents missing',
        },
        death_registry_lookup: { status: 'pending', detail: 'Skipped \u2014 documents incomplete' },
        obituary_search: { status: 'pending', detail: 'Skipped \u2014 documents incomplete' },
        beneficiary_auth: { status: 'pending', detail: 'Skipped \u2014 documents incomplete' },
        policy_verification: { status: 'pending', detail: 'Skipped \u2014 documents incomplete' },
        fraud_analysis: { status: 'pending', detail: 'Skipped \u2014 documents incomplete' },
        adjudication: {
          status: 'completed',
          detail: 'Escalated \u2014 missing required documents (deterministic check)',
        },
      },
    }
  }

  return {
    processingPath,
    steps: {
      claim_received: { status: 'completed', detail: 'Claim recorded' },
      document_verification: {
        status: 'completed',
        detail: docsVerified === false ? 'Issues found in documents' :
                docFindings ? docFindings.substring(0, 120) : 'Documents analyzed',
      },
      death_registry_lookup: {
        status: 'completed',
        detail: authPassed ? 'Death record verified in registry' : 'Registry check flagged concerns',
      },
      obituary_search: {
        status: 'completed',
        detail: authPassed ? 'Obituary and funeral records found' : 'Limited public records found',
      },
      beneficiary_auth: {
        status: authPassed === false ? 'failed' : 'completed',
        detail: authPassed ? 'Beneficiary identity confirmed' : 'Authentication concerns flagged',
      },
      policy_verification: {
        status: policyValid === false ? 'failed' : 'completed',
        detail: policyValid ? 'Policy active and in force' : 'Policy verification failed',
      },
      fraud_analysis: {
        status: fraudScore !== null && fraudScore >= 0.7 ? 'failed' : 'completed',
        detail: fraudScore !== null
          ? `Fraud score: ${(fraudScore * 100).toFixed(0)}% — ${fraudScore < 0.3 ? 'Low risk' : fraudScore < 0.7 ? 'Moderate risk' : 'High risk'}`
          : 'Analysis complete',
      },
      adjudication: {
        status: isFailed ? 'failed' : 'completed',
        detail: decision === 'approved' ? 'Claim approved' :
                decision === 'denied' ? 'Claim denied' :
                decision === 'escalated' ? 'Escalated to human adjuster' : 'Decision pending',
      },
    },
  }
}

// ── Processing Flow Sidebar Component ─────────────────────────────────

function ProcessingFlow({ claim }: { claim: any }) {
  const { steps: stepStatuses, processingPath } = getStepStatuses(claim)

  const statusLine = (s: StepStatus) => {
    switch (s) {
      case 'completed': return 'bg-emerald-400'
      case 'failed': return 'bg-red-400'
      case 'active': return 'bg-blue-400 animate-pulse'
      case 'pending': return 'bg-gray-200'
    }
  }

  const agentBadge = (agent: string) => {
    const colors: Record<string, string> = {
      'System': 'bg-gray-100 text-gray-600',
      'Extractor Agent': 'bg-purple-100 text-purple-700',
      'Authenticator Agent': 'bg-blue-100 text-blue-700',
      'Policy Verification Agent': 'bg-teal-100 text-teal-700',
      'Fraud Detection Agent': 'bg-orange-100 text-orange-700',
      'Adjudication Agent': 'bg-indigo-100 text-indigo-700',
    }
    return colors[agent] || 'bg-gray-100 text-gray-600'
  }

  const pathLabel = processingPath === 'agentcore'
    ? 'AgentCore Multi-Agent Pipeline'
    : processingPath === 'bedrock_direct'
    ? 'Bedrock Direct Invoke'
    : null

  const pathBadgeColor = processingPath === 'agentcore'
    ? 'bg-violet-100 text-violet-700 border-violet-200'
    : 'bg-amber-100 text-amber-700 border-amber-200'

  return (
    <div>
      <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
        <Brain className="h-5 w-5 text-primary-600" />
        AI Processing Flow
      </h3>
      <p className="text-xs text-gray-500 mb-2">Multi-agent verification pipeline</p>

      {pathLabel && (
        <div className={`text-[11px] font-medium px-2 py-1 rounded border mb-4 inline-block ${pathBadgeColor}`}>
          ⚡ {pathLabel}
        </div>
      )}
      {!pathLabel && <div className="mb-4" />}

      <div className="space-y-0">
        {FLOW_STEPS.map((step, index) => {
          const info = stepStatuses[step.id] || { status: 'pending' as StepStatus }
          const Icon = step.icon
          const isLast = index === FLOW_STEPS.length - 1
          const dynamicToolCall = getToolCall(step.id, processingPath)

          return (
            <div key={step.id} className="relative flex gap-3">
              {!isLast && (
                <div className="absolute left-[17px] top-[36px] bottom-0 w-0.5">
                  <div className={`h-full ${statusLine(info.status)}`} />
                </div>
              )}

              <div className="relative z-10 flex-shrink-0 mt-1">
                <div className={`w-[35px] h-[35px] rounded-full flex items-center justify-center border-2 ${
                  info.status === 'completed' ? 'border-emerald-400 bg-emerald-50' :
                  info.status === 'failed' ? 'border-red-400 bg-red-50' :
                  info.status === 'active' ? 'border-blue-400 bg-blue-50' :
                  'border-gray-200 bg-gray-50'
                }`}>
                  {info.status === 'completed' ? <CheckCircle className="h-4 w-4 text-emerald-500" /> :
                   info.status === 'failed' ? <XCircle className="h-4 w-4 text-red-500" /> :
                   info.status === 'active' ? <Loader2 className="h-4 w-4 text-blue-500 animate-spin" /> :
                   <Icon className="h-4 w-4 text-gray-400" />}
                </div>
              </div>

              <div className={`flex-1 pb-5 ${info.status === 'pending' ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-900">{step.label}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${agentBadge(step.agent)}`}>
                    {step.agent}
                  </span>
                </div>
                {info.detail && (
                  <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{info.detail}</p>
                )}
                {dynamicToolCall && info.status !== 'pending' && (
                  <p className="text-[10px] text-gray-400 mt-0.5 font-mono">{dynamicToolCall}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Documents Present Component (for Adjuster context on resubmissions) ───

function DocumentsPresent({ claimId }: { claimId: string }) {
  const [documents, setDocuments] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const docPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const fetchDocs = async () => {
      try {
        const result = await claimsApi.getDocuments(claimId)
        setDocuments(result.documents || [])
      } catch {
        setDocuments([])
      } finally {
        setLoading(false)
      }
    }
    fetchDocs()

    // Poll every 10s so adjuster sees newly uploaded documents
    docPollRef.current = setInterval(fetchDocs, 10000)
    return () => { if (docPollRef.current) clearInterval(docPollRef.current) }
  }, [claimId])

  if (loading) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading documents...
        </div>
      </div>
    )
  }

  const requiredTypes = ['death_certificate', 'medical_records', 'beneficiary_id']
  const foundTypes = new Set(documents.map(d => d.documentType?.toLowerCase()))

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 mb-6">
      <div className="flex items-start gap-3">
        <div className="bg-slate-100 rounded-lg p-2">
          <Paperclip className="h-5 w-5 text-slate-700" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-slate-900 mb-2">Documents on File</h4>
          {documents.length === 0 ? (
            <p className="text-sm text-slate-500">No documents uploaded for this claim.</p>
          ) : (
            <div className="space-y-1.5">
              {documents.map((doc: any, idx: number) => (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span className="text-slate-700 font-medium">
                    {doc.documentType?.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) || 'Document'}
                  </span>
                  <span className="text-slate-400 text-xs truncate">{'\u2014'} {doc.fileName}</span>
                  <span className="text-slate-400 text-xs ml-auto shrink-0">
                    {doc.size ? `${(doc.size / 1024).toFixed(0)} KB` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Show which required docs are missing */}
          {documents.length > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-200">
              <p className="text-xs font-medium text-slate-500 mb-1">Required Document Checklist:</p>
              <div className="flex flex-wrap gap-2">
                {requiredTypes.map(type => {
                  const present = foundTypes.has(type)
                  const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  return (
                    <span key={type} className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      present ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {present ? '\u2713' : '\u2717'} {label}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main AdjusterWorkbench Component ──────────────────────────────────

export default function AdjusterWorkbench() {
  const [claims, setClaims] = useState<any[]>([])
  const [selectedClaim, setSelectedClaim] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [flowCollapsed, setFlowCollapsed] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const fetchClaims = async () => {
      try {
        const data = await claimsApi.getClaims()
        const all = Array.isArray(data) ? data : data.claims || []
        const reviewStatuses = ['escalated', 'submitted', 'processing', 'resubmitted', 'approved', 'denied']
        setClaims(all.filter((c: any) => reviewStatuses.includes(c.status)))
      } catch (error) {
        console.error('Failed to fetch claims:', error)
      } finally {
        setLoading(false)
      }
    }
    fetchClaims()
  }, [])

  // Auto-poll selected claim while processing
  useEffect(() => {
    if (!selectedClaim) return
    const status = (selectedClaim.status || '').toLowerCase()
    if (status !== 'submitted' && status !== 'processing' && status !== 'resubmitted') return

    pollRef.current = setInterval(async () => {
      try {
        const updated = await claimsApi.getClaim(selectedClaim.claimId)
        setSelectedClaim(updated)
        setClaims(prev => prev.map(c => c.claimId === updated.claimId ? updated : c))
        const s = (updated.status || '').toLowerCase()
        if (s !== 'submitted' && s !== 'processing') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
        }
      } catch { /* ignore */ }
    }, 3000)

    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedClaim?.claimId, selectedClaim?.status])

  const [adjusterNotes, setAdjusterNotes] = useState('')

  const handleApprove = async (claimId: string) => {
    try {
      await claimsApi.approveClaim(claimId, adjusterNotes || 'Approved by adjuster')
      setClaims(claims.filter(c => c.claimId !== claimId))
      setSelectedClaim(null)
      setAdjusterNotes('')
    } catch (error) {
      console.error('Failed to approve claim:', error)
    }
  }

  const handleDeny = async (claimId: string) => {
    try {
      await claimsApi.denyClaim(claimId, adjusterNotes || 'Denied by adjuster')
      setClaims(claims.filter(c => c.claimId !== claimId))
      setSelectedClaim(null)
      setAdjusterNotes('')
    } catch (error) {
      console.error('Failed to deny claim:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 text-primary-500 animate-spin" />
        <span className="ml-3 text-gray-500">Loading claims for review...</span>
      </div>
    )
  }

  return (
    <div className="max-w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8 flex justify-between items-center">
        <div>
          <h2 className="page-title">Adjuster Workbench</h2>
          <p className="page-subtitle">Review and process pending claims</p>
        </div>
        <button
          onClick={async () => {
            if (!confirm('Reset demo? This will delete ALL claims and uploaded documents.')) return
            try {
              const result = await claimsApi.resetDemo()
              alert(`Demo reset complete.\n\nClaims deleted: ${result.claimsDeleted}\nDocuments deleted: ${result.documentsDeleted}`)
              window.location.reload()
            } catch (error: any) {
              alert('Reset failed: ' + (error.response?.data?.error || error.message))
            }
          }}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
        >
          <RotateCcw className="h-4 w-4" />
          Reset Demo
        </button>
      </div>

      <div className="flex gap-6">
        {/* Left: Claims Queue */}
        <div className="w-72 flex-shrink-0">
          <div className="card-flat">
            {/* Requires Action Section */}
            {(() => {
              const actionable = claims.filter((c: any) => ['escalated', 'resubmitted', 'submitted', 'processing'].includes(c.status))
              const resubmittedCount = claims.filter((c: any) => c.status === 'resubmitted').length
              return (
                <>
                  <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    Requires Action
                    {actionable.length > 0 && (
                      <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto">
                        {actionable.length}
                      </span>
                    )}
                  </h3>
                  {resubmittedCount > 0 && (
                    <div className="mb-3 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-700 flex items-center gap-2">
                      <span className="bg-purple-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{resubmittedCount}</span>
                      Resubmitted {resubmittedCount === 1 ? 'claim requires' : 'claims require'} priority review
                    </div>
                  )}
                  {actionable.length === 0 ? (
                    <div className="text-center py-6 mb-4">
                      <CheckCircle className="h-8 w-8 text-emerald-300 mx-auto mb-2" />
                      <p className="text-xs text-gray-500">No claims pending action</p>
                    </div>
                  ) : (
                    <ul className="space-y-2 mb-4 max-h-[calc(100vh-450px)] overflow-y-auto">
                      {actionable.map((claim: any) => (
                        <li key={claim.claimId}>
                          <button
                            onClick={() => setSelectedClaim(claim)}
                            className={`w-full text-left p-3 rounded-lg border-2 transition-all duration-200 ${
                              selectedClaim?.claimId === claim.claimId
                                ? 'border-primary-500 bg-primary-50 shadow-sm'
                                : 'border-gray-100 hover:border-primary-200 hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-sm text-gray-900 truncate flex-1">{claim.claimId}</p>
                              {claim.status === 'resubmitted' && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold shrink-0">UPDATED</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">{claim.policyHolderName || 'Death Benefit'}</p>
                            <div className="flex items-center justify-between mt-1">
                              {claim.claimAmount && (
                                <p className="text-xs font-semibold text-primary-600">${claim.claimAmount.toLocaleString()}</p>
                              )}
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                claim.status === 'escalated' ? 'bg-amber-100 text-amber-700' :
                                claim.status === 'resubmitted' ? 'bg-purple-100 text-purple-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>{claim.status}</span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            })()}

            {/* Completed Section */}
            {(() => {
              const completed = claims.filter((c: any) => ['approved', 'denied'].includes(c.status))
              if (completed.length === 0) return null
              return (
                <>
                  <div className="border-t border-gray-200 pt-3">
                    <h3 className="font-semibold text-gray-500 text-xs uppercase tracking-wide mb-3 flex items-center gap-2">
                      Completed
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full ml-auto">{completed.length}</span>
                    </h3>
                    <ul className="space-y-2 max-h-48 overflow-y-auto">
                      {completed.map((claim: any) => (
                        <li key={claim.claimId}>
                          <button
                            onClick={() => setSelectedClaim(claim)}
                            className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                              selectedClaim?.claimId === claim.claimId
                                ? 'border-primary-500 bg-primary-50'
                                : 'border-gray-50 hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <p className="font-medium text-xs text-gray-700 truncate">{claim.claimId}</p>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                claim.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                                'bg-red-100 text-red-700'
                              }`}>{claim.status}</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-0.5">{claim.policyHolderName || '-'}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )
            })()}
          </div>
        </div>

        {/* Center: Claim Detail */}
        <div className="flex-1 min-w-0">
          {selectedClaim ? (
            <div className="card-flat">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-xl font-bold text-gray-900">Claim {selectedClaim.claimId}</h3>
                  <p className="text-sm text-gray-500">{selectedClaim.policyHolderName || 'Death Benefit'}</p>
                </div>
                <span className={`text-sm px-3 py-1 rounded-full font-medium ${
                  selectedClaim.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                  selectedClaim.status === 'denied' ? 'bg-red-100 text-red-700' :
                  selectedClaim.status === 'escalated' ? 'bg-amber-100 text-amber-700' :
                  'bg-gray-100 text-gray-600'
                }`}>{selectedClaim.status}</span>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Amount</p>
                  <p className="text-lg font-bold text-gray-900 mt-1">${selectedClaim.claimAmount?.toLocaleString() || '-'}</p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Submitted</p>
                  <p className="text-lg font-bold text-gray-900 mt-1">{selectedClaim.submittedAt ? new Date(selectedClaim.submittedAt * 1000).toLocaleDateString() : '-'}</p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Policy Number</p>
                  <p className="text-lg font-bold text-gray-900 mt-1">{selectedClaim.policyNumber || '-'}</p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Beneficiary</p>
                  <p className="text-lg font-bold text-gray-900 mt-1">{selectedClaim.beneficiaryName || '-'}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
                <div>
                  <span className="text-gray-500">Relationship:</span>
                  <span className="ml-2 font-medium text-gray-900">{selectedClaim.relationship || '-'}</span>
                </div>
                <div>
                  <span className="text-gray-500">Date of Death:</span>
                  <span className="ml-2 font-medium text-gray-900">{selectedClaim.dateOfDeath || '-'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-gray-500">Cause of Death:</span>
                  <span className="ml-2 font-medium text-gray-900">{selectedClaim.causeOfDeath || '-'}</span>
                </div>
              </div>

              {selectedClaim.aiInsights && (
                <div className="bg-gradient-to-r from-primary-50 to-blue-50 border border-primary-100 rounded-xl p-5 mb-6">
                  <div className="flex items-start gap-3">
                    <div className="bg-primary-100 rounded-lg p-2">
                      <Brain className="h-5 w-5 text-primary-700" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-primary-900 mb-1">AI Insights</h4>
                      <p className="text-sm text-primary-800 leading-relaxed">{selectedClaim.aiInsights}</p>
                      {(() => {
                        try {
                          const d = typeof selectedClaim.processingDetails === 'string'
                            ? JSON.parse(selectedClaim.processingDetails) : selectedClaim.processingDetails
                          if (!d) return null
                          return (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {d.confidence != null && (
                                <span className="text-xs px-2 py-1 bg-white/60 rounded-full text-primary-700">
                                  Confidence: {(d.confidence * 100).toFixed(0)}%
                                </span>
                              )}
                              {d.fraud_score != null && (
                                <span className={`text-xs px-2 py-1 rounded-full ${
                                  d.fraud_score < 0.3 ? 'bg-emerald-100 text-emerald-700' :
                                  d.fraud_score < 0.7 ? 'bg-amber-100 text-amber-700' :
                                  'bg-red-100 text-red-700'
                                }`}>
                                  Fraud Score: {(d.fraud_score * 100).toFixed(0)}%
                                </span>
                              )}
                              {d.documents_verified != null && (
                                <span className={`text-xs px-2 py-1 rounded-full ${
                                  d.documents_verified ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                                }`}>
                                  Docs: {d.documents_verified ? 'Verified' : 'Issues Found'}
                                </span>
                              )}
                            </div>
                          )
                        } catch { return null }
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {/* Escalation Reason — adjuster-specific context for escalated claims */}
              {selectedClaim.status === 'escalated' && (() => {
                try {
                  const d = typeof selectedClaim.processingDetails === 'string'
                    ? JSON.parse(selectedClaim.processingDetails) : selectedClaim.processingDetails
                  if (!d) return null
                  const amount = selectedClaim.claimAmount || 0
                  const fraudScore = d.fraud_score || 0
                  const docsVerified = d.documents_verified

                  let reason = ''
                  if (docsVerified === false) {
                    reason = 'Missing required documentation. See Document Verification below for details.'
                  } else if (amount >= 100000) {
                    reason = `Claim amount ($${amount.toLocaleString()}) exceeds the $100,000 auto-approval threshold. All documents verified and no fraud indicators \u2014 requires senior adjuster sign-off per company policy.`
                  } else if (fraudScore >= 0.5 && fraudScore < 0.7) {
                    reason = `Moderate fraud risk score (${(fraudScore * 100).toFixed(0)}%). Requires human review to assess flagged indicators before decision.`
                  } else if (d.reasoning) {
                    reason = d.reasoning.substring(0, 300)
                  }

                  if (!reason) return null
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="bg-amber-100 rounded-lg p-2">
                          <AlertTriangle className="h-5 w-5 text-amber-700" />
                        </div>
                        <div>
                          <h4 className="font-semibold text-amber-900 mb-1">Escalation Reason</h4>
                          <p className="text-sm text-amber-800 leading-relaxed">{reason}</p>
                        </div>
                      </div>
                    </div>
                  )
                } catch { return null }
              })()}

              {/* Document Findings */}
              {(() => {
                try {
                  const d = typeof selectedClaim.processingDetails === 'string'
                    ? JSON.parse(selectedClaim.processingDetails) : selectedClaim.processingDetails
                  if (!d?.document_findings) return null
                  return (
                    <div className="bg-purple-50 border border-purple-100 rounded-xl p-5 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="bg-purple-100 rounded-lg p-2">
                          <FileSearch className="h-5 w-5 text-purple-700" />
                        </div>
                        <div>
                          <h4 className="font-semibold text-purple-900 mb-1">Document Verification</h4>
                          <p className="text-sm text-purple-800 leading-relaxed">{d.document_findings}</p>
                        </div>
                      </div>
                    </div>
                  )
                } catch { return null }
              })()}

              {/* Documents on File — shows S3 documents for adjuster decision-making */}
              <DocumentsPresent claimId={selectedClaim.claimId} />

              {/* Approve / Deny buttons — only for actionable statuses */}
              {['escalated', 'submitted', 'processing', 'resubmitted'].includes(selectedClaim.status) && (
                <div className="pt-4 border-t border-gray-100 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Adjuster Notes</label>
                    <textarea
                      value={adjusterNotes}
                      onChange={(e) => setAdjusterNotes(e.target.value)}
                      placeholder="Add comments or reason for your decision..."
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary-400 focus:ring-1 focus:ring-primary-400 outline-none resize-none"
                      rows={2}
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleApprove(selectedClaim.claimId)}
                      className="btn-success flex items-center gap-2 flex-1 justify-center"
                    >
                      <CheckCircle className="h-5 w-5" />
                      Approve Claim
                    </button>
                    <button
                      onClick={() => handleDeny(selectedClaim.claimId)}
                      className="btn-danger flex items-center gap-2 flex-1 justify-center"
                    >
                      <XCircle className="h-5 w-5" />
                      Deny Claim
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card-flat text-center py-16">
              <div className="bg-gray-100 rounded-full p-4 w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                <ClipboardCheck className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-gray-500 font-medium">Select a claim to review</p>
              <p className="text-sm text-gray-400 mt-1">Choose from the queue on the left</p>
            </div>
          )}
        </div>

        {/* Right: Processing Flow Sidebar */}
        {selectedClaim && (
          <div className={`transition-all duration-300 flex-shrink-0 ${flowCollapsed ? 'w-10' : 'w-80'}`}>
            <div className="sticky top-4">
              {flowCollapsed ? (
                <button
                  onClick={() => setFlowCollapsed(false)}
                  className="w-10 h-10 rounded-lg bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50"
                  title="Show processing flow"
                >
                  <ChevronLeft className="h-4 w-4 text-gray-500" />
                </button>
              ) : (
                <div className="card-flat relative">
                  <button
                    onClick={() => setFlowCollapsed(true)}
                    className="absolute top-3 right-3 w-6 h-6 rounded flex items-center justify-center hover:bg-gray-100"
                    title="Collapse"
                  >
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </button>
                  <ProcessingFlow claim={selectedClaim} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

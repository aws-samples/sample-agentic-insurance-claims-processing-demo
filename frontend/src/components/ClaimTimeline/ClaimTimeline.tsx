import { CheckCircle, Clock, AlertTriangle, XCircle, FileText, Brain, Upload, RefreshCw } from 'lucide-react'

interface TimelineEvent {
  id: string
  label: string
  timestamp?: number | string
  status: 'completed' | 'active' | 'pending' | 'error'
  detail?: string
}

function getTimelineEvents(claim: any): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const status = (claim.status || '').toLowerCase()

  // 1. Submitted
  events.push({
    id: 'submitted',
    label: 'Claim Submitted',
    timestamp: claim.submittedAt,
    status: 'completed',
    detail: `Claim ${claim.claimId} received`,
  })

  // 2. Documents uploaded (if any)
  if (claim.documents && claim.documents.length > 0) {
    events.push({
      id: 'documents',
      label: 'Documents Uploaded',
      timestamp: claim.documents[0]?.uploadedAt || claim.submittedAt,
      status: 'completed',
      detail: `${claim.documents.length} document(s) attached`,
    })
  }

  // 3. AI Processing
  if (['processing', 'approved', 'denied', 'escalated', 'resubmitted'].includes(status)) {
    events.push({
      id: 'processing',
      label: 'Claim Under Review',
      timestamp: claim.processedAt || undefined,
      status: status === 'processing' ? 'active' : 'completed',
      detail: 'Verifying policy details, documents, and eligibility',
    })
  } else if (status === 'submitted') {
    events.push({
      id: 'processing',
      label: 'Claim Under Review',
      status: 'pending',
      detail: 'Your claim is in the queue for review',
    })
  }

  // 4. Decision made
  if (['approved', 'denied', 'escalated'].includes(status)) {
    const decisionLabel = status === 'approved' ? 'Claim Approved' :
      status === 'denied' ? 'Claim Denied' : 'Escalated to Adjuster'
    events.push({
      id: 'decision',
      label: decisionLabel,
      timestamp: claim.processedAt,
      status: status === 'denied' ? 'error' : 'completed',
      detail: claim.aiDecision ? `Decision: ${claim.aiDecision} (confidence: ${Math.round((claim.aiConfidence || 0) * 100)}%)` : undefined,
    })
  }

  // 5. Resubmission (if applicable)
  if (claim.resubmissionCount && claim.resubmissionCount > 0) {
    events.push({
      id: 'resubmitted',
      label: `Resubmitted (Attempt ${claim.resubmissionCount}/5)`,
      timestamp: claim.resubmittedAt,
      status: status === 'resubmitted' ? 'active' : 'completed',
      detail: 'Additional information provided for re-review',
    })
  }

  // 6. Adjuster action (if manually approved/denied after escalation)
  if (claim.approvedAt) {
    events.push({
      id: 'adjuster_approved',
      label: 'Adjuster Approved',
      timestamp: claim.approvedAt,
      status: 'completed',
      detail: claim.approvalNotes || 'Manually approved by adjuster',
    })
  } else if (claim.deniedAt && status === 'denied' && claim.denialReason) {
    events.push({
      id: 'adjuster_denied',
      label: 'Adjuster Denied',
      timestamp: claim.deniedAt,
      status: 'error',
      detail: claim.denialReason,
    })
  }

  return events
}

function getIcon(event: TimelineEvent) {
  switch (event.id) {
    case 'submitted': return <FileText className="h-4 w-4" />
    case 'documents': return <Upload className="h-4 w-4" />
    case 'processing': return <Brain className="h-4 w-4" />
    case 'resubmitted': return <RefreshCw className="h-4 w-4" />
    default:
      if (event.status === 'error') return <XCircle className="h-4 w-4" />
      if (event.status === 'active') return <Clock className="h-4 w-4" />
      if (event.label.includes('Escalated')) return <AlertTriangle className="h-4 w-4" />
      return <CheckCircle className="h-4 w-4" />
  }
}

function getStatusColors(status: TimelineEvent['status']) {
  switch (status) {
    case 'completed': return 'bg-emerald-100 text-emerald-600 border-emerald-300'
    case 'active': return 'bg-blue-100 text-blue-600 border-blue-300 animate-pulse'
    case 'error': return 'bg-red-100 text-red-600 border-red-300'
    case 'pending': return 'bg-gray-100 text-gray-400 border-gray-200'
  }
}

function formatTimestamp(ts: number | string | undefined): string {
  if (!ts) return ''
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ClaimTimeline({ claim }: { claim: any }) {
  const events = getTimelineEvents(claim)

  if (events.length === 0) return null

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Clock className="h-4 w-4 text-gray-500" />
        Claim Timeline
      </h3>
      <div className="relative">
        {events.map((event, index) => (
          <div key={event.id} className="flex gap-3 mb-4 last:mb-0">
            {/* Connector line */}
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${getStatusColors(event.status)}`}>
                {getIcon(event)}
              </div>
              {index < events.length - 1 && (
                <div className={`w-0.5 flex-1 mt-1 ${event.status === 'completed' ? 'bg-emerald-200' : 'bg-gray-200'}`} />
              )}
            </div>
            {/* Content */}
            <div className="flex-1 pb-2">
              <div className="flex items-center justify-between">
                <p className={`text-sm font-medium ${event.status === 'pending' ? 'text-gray-400' : 'text-gray-900'}`}>
                  {event.label}
                </p>
                {event.timestamp && (
                  <span className="text-xs text-gray-400">{formatTimestamp(event.timestamp)}</span>
                )}
              </div>
              {event.detail && (
                <p className="text-xs text-gray-500 mt-0.5">{event.detail}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { RefreshCw, Upload, AlertTriangle, Loader2 } from 'lucide-react'
import { claimsApi } from '@/services/api'

interface ResubmitPanelProps {
  claim: any
  onResubmitted: () => void
}

export default function ResubmitPanel({ claim, onResubmitted }: ResubmitPanelProps) {
  const [notes, setNotes] = useState('')
  const [additionalNotes, setAdditionalNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const status = (claim.status || '').toLowerCase()
  const resubmissionCount = claim.resubmissionCount || 0
  const canResubmit = (status === 'escalated' || status === 'denied') && resubmissionCount < 5

  if (!canResubmit) return null

  const handleResubmit = async () => {
    if (!notes.trim()) {
      setError('Please provide a note explaining what additional information you are providing.')
      return
    }

    setLoading(true)
    setError('')

    try {
      await claimsApi.resubmitClaim(claim.claimId, {
        notes: notes.trim(),
        additionalNotes: additionalNotes.trim() || undefined,
      })
      setSuccess(true)
      setTimeout(() => onResubmitted(), 1500)
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to resubmit claim. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
        <div className="flex items-center gap-2 text-emerald-700">
          <RefreshCw className="h-5 w-5" />
          <p className="font-medium">Claim resubmitted successfully!</p>
        </div>
        <p className="text-sm text-emerald-600 mt-1">Your claim is being re-processed with the new information.</p>
      </div>
    )
  }

  // Parse previous reasoning and simplify for claimant
  let claimantMessage = ''
  try {
    // Check for claimant-safe documentStatus field (set by backend for missing docs)
    const docStatus = claim.documentStatus || ''
    if (docStatus && docStatus.toLowerCase().includes('missing')) {
      const missingDocs: string[] = []
      if (docStatus.toLowerCase().includes('death certificate')) missingDocs.push('Death Certificate (certified copy)')
      if (docStatus.toLowerCase().includes('medical record')) missingDocs.push('Medical Records (hospital/physician records)')
      if (docStatus.toLowerCase().includes('beneficiary id')) missingDocs.push('Beneficiary ID (government-issued photo ID)')
      if (missingDocs.length > 0) {
        claimantMessage = `To continue processing your claim, please upload the following missing documents:\n\n• ${missingDocs.join('\n• ')}`
      }
    }

    // Fallback: try parsing processingDetails (available for adjusters or older data)
    if (!claimantMessage && claim.processingDetails) {
      const details = typeof claim.processingDetails === 'string'
        ? JSON.parse(claim.processingDetails) : claim.processingDetails

      // Use document_findings (more structured) if available, fallback to reasoning
      const docFindings = (details.document_findings || '').toLowerCase()
      const reasoning = (details.reasoning || details.error || '').toLowerCase()

      // Extract missing documents from document_findings first (more reliable)
      const missingDocs: string[] = []

      // Check document_findings for "Missing: X" pattern
      if (docFindings.includes('missing')) {
        if (docFindings.includes('death certificate') && docFindings.indexOf('death certificate') > docFindings.indexOf('missing')) {
          missingDocs.push('Death Certificate')
        }
        if (docFindings.includes('medical record') && docFindings.indexOf('medical record') > docFindings.indexOf('missing')) {
          missingDocs.push('Medical Records')
        }
        if (docFindings.includes('beneficiary id') && docFindings.indexOf('beneficiary id') > docFindings.indexOf('missing')) {
          missingDocs.push('Beneficiary ID (government-issued photo ID)')
        }
      }

      // Fallback: check reasoning but only if docFindings didn't give results
      if (missingDocs.length === 0 && reasoning.includes('missing required documents')) {
        // Parse from the deterministic escalation message format:
        // "Missing required documents: Death Certificate, Medical Records..."
        const missingMatch = reasoning.match(/missing required documents?:\s*([^.]+)/i)
        if (missingMatch) {
          const missingList = missingMatch[1]
          if (missingList.includes('death certificate')) missingDocs.push('Death Certificate')
          if (missingList.includes('medical records')) missingDocs.push('Medical Records')
          if (missingList.includes('beneficiary id')) missingDocs.push('Beneficiary ID (government-issued photo ID)')
        }
      }

      if (missingDocs.length > 0) {
        claimantMessage = `To continue processing your claim, please provide the following:\n\n• ${missingDocs.join('\n• ')}`
      } else if (reasoning.includes('beneficiary') && reasoning.includes('not the designated')) {
        claimantMessage = 'The claimant information does not match the policy beneficiary on record. Please provide legal documentation (power of attorney, executor appointment, or court order) establishing your right to file this claim.'
      } else if (status === 'denied' && reasoning.includes('lapsed')) {
        claimantMessage = 'This policy was not active at the time of the loss. If you believe this is incorrect, please contact us with proof of premium payment or policy reinstatement.'
      } else {
        claimantMessage = 'Additional review is needed for your claim. Please upload any supporting documents you have and provide any additional details that may help us process your claim.'
      }
    }
  } catch { /* ignore parsing errors */ }

  if (!claimantMessage) {
    claimantMessage = status === 'escalated'
      ? 'We need additional information to complete your claim review. Please upload any supporting documents and provide details below.'
      : 'If you have additional supporting documentation, you can resubmit your claim for re-review.'
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
      <div className="flex items-start gap-3 mb-4">
        <div className="bg-amber-100 rounded-lg p-2">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-amber-900">
            {status === 'escalated' ? 'Additional Information Required' : 'Claim Denied — You May Resubmit'}
          </h3>
          <p className="text-sm text-amber-700 mt-1">
            {status === 'escalated'
              ? 'This claim needs additional documents or information before a decision can be made.'
              : 'Your claim was denied. If you have additional supporting documentation, you can resubmit for re-review.'}
          </p>
          {claimantMessage && (
            <div className="mt-3 bg-white rounded-lg border border-amber-200 p-3">
              <p className="text-xs font-semibold text-gray-700 mb-1">What we need from you:</p>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{claimantMessage}</p>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Resubmission attempts: {resubmissionCount}/5
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="resubmit-notes" className="block text-xs font-medium text-gray-700 mb-1">
            What additional information are you providing? *
          </label>
          <textarea
            id="resubmit-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., I have uploaded the missing death certificate and medical records..."
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            rows={3}
          />
        </div>

        <div>
          <label htmlFor="resubmit-additional" className="block text-xs font-medium text-gray-700 mb-1">
            Additional context (optional)
          </label>
          <textarea
            id="resubmit-additional"
            value={additionalNotes}
            onChange={(e) => setAdditionalNotes(e.target.value)}
            placeholder="Any additional context that may help with the re-review..."
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            rows={2}
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <p className="text-xs text-gray-400 flex items-center gap-1">
            <Upload className="h-3 w-3" />
            Upload any new documents using the document upload section above before resubmitting.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          onClick={handleResubmit}
          disabled={loading || !notes.trim()}
          className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 rounded-lg transition-colors text-sm"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Resubmitting...
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" />
              Resubmit for Review (Attempt {resubmissionCount + 1}/5)
            </>
          )}
        </button>
      </div>
    </div>
  )
}

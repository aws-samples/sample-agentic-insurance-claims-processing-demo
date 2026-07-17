import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { claimsApi } from '@/services/api'
import {
  ArrowLeft, Loader2, Calendar, DollarSign, User, FileSearch, AlertTriangle, Info, Upload, X
} from 'lucide-react'
import ClaimTimeline from '@/components/ClaimTimeline/ClaimTimeline'
import ResubmitPanel from '@/components/ResubmitPanel/ResubmitPanel'

function DocumentUploadSection({ claimId }: { claimId: string }) {
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (newFiles: FileList | null) => {
    if (newFiles) setFiles(prev => [...prev, ...Array.from(newFiles)])
  }

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return
    setUploading(true)
    try {
      await claimsApi.uploadDocuments(claimId, files)
      setUploaded(true)
      setFiles([])
    } catch (error) {
      console.error('Upload failed:', error)
      alert('Document upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
        <Upload className="h-4 w-4 text-blue-500" />
        Upload Additional Documents
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Upload missing documents (death certificate, medical records, ID) before resubmitting your claim.
      </p>

      {uploaded && (
        <div className="mb-3 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-700">
          Documents uploaded successfully. You can now resubmit your claim below.
        </div>
      )}

      <div
        className="flex justify-center px-4 py-4 border-2 border-gray-300 border-dashed rounded-lg hover:border-blue-400 transition-colors cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleFiles(e.dataTransfer.files) }}
      >
        <div className="text-center">
          <Upload className="mx-auto h-8 w-8 text-gray-400" />
          <p className="text-sm text-gray-600 mt-1">
            <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-gray-400">PDF, TXT, JPG, PNG up to 10MB</p>
          <input ref={fileInputRef} type="file" className="sr-only" multiple
            onChange={(e) => handleFiles(e.target.files)} accept=".pdf,.txt,.jpg,.jpeg,.png" />
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-3 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
              <div className="flex items-center gap-2 min-w-0">
                <Upload className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span className="text-sm text-gray-700 truncate">{file.name}</span>
                <span className="text-xs text-gray-400 shrink-0">({(file.size / 1024).toFixed(0)} KB)</span>
              </div>
              <button onClick={() => removeFile(index)} className="text-gray-400 hover:text-red-500 ml-2">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-medium py-2 px-4 rounded-lg transition-colors text-sm"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? 'Uploading...' : `Upload ${files.length} Document${files.length > 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  )
}

export default function ClaimDetails() {
  const { claimId } = useParams<{ claimId: string }>()
  const [claim, setClaim] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const fetchClaim = async () => {
      if (!claimId) return
      try {
        const data = await claimsApi.getClaim(claimId)
        setClaim(data)

        const status = (data.status || '').toLowerCase()
        if (status === 'submitted' || status === 'processing') {
          if (!pollRef.current) {
            pollRef.current = setInterval(async () => {
              try {
                const updated = await claimsApi.getClaim(claimId)
                setClaim(updated)
                const s = (updated.status || '').toLowerCase()
                if (s !== 'submitted' && s !== 'processing') {
                  if (pollRef.current) clearInterval(pollRef.current)
                  pollRef.current = null
                }
              } catch { /* ignore poll errors */ }
            }, 3000)
          }
        }
      } catch (error) {
        console.error('Failed to fetch claim:', error)
      } finally {
        setLoading(false)
      }
    }
    fetchClaim()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [claimId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 text-primary-500 animate-spin" />
      </div>
    )
  }

  if (!claim) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-500">Claim not found.</p>
        <Link to="/claimant" className="text-primary-600 hover:text-primary-800 mt-4 inline-block font-medium">
          Back to My Claims
        </Link>
      </div>
    )
  }

  const statusClass =
    claim.status === 'approved' ? 'badge-success' :
    claim.status === 'denied' ? 'badge-danger' : 'badge-warning'

  const submittedDate = claim.submittedAt
    ? new Date(claim.submittedAt * 1000).toLocaleDateString()
    : '-'

  let details: any = {}
  if (claim.processingDetails) {
    try {
      details = typeof claim.processingDetails === 'string'
        ? JSON.parse(claim.processingDetails) : claim.processingDetails
    } catch { /* ignore */ }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/claimant" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-800 mb-6 font-medium">
        <ArrowLeft className="h-4 w-4" />
        Back to My Claims
      </Link>

      <div className="card-flat mb-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="page-title">Claim {claim.claimId}</h2>
            <p className="page-subtitle">Policy: {claim.policyNumber || '-'}</p>
          </div>
          <span className={`${statusClass} text-sm px-4 py-1.5`}>
            {claim.status || 'submitted'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
            <DollarSign className="h-5 w-5 text-emerald-500 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Claim Amount</p>
              <p className="font-medium text-gray-900 mt-0.5">
                ${claim.claimAmount?.toLocaleString() || '-'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
            <Calendar className="h-5 w-5 text-amber-500 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Submitted</p>
              <p className="font-medium text-gray-900 mt-0.5">{submittedDate}</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
            <User className="h-5 w-5 text-primary-500 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Beneficiary</p>
              <p className="font-medium text-gray-900 mt-0.5">{claim.beneficiaryName || '-'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Claim Details */}
      <div className="card-flat mb-6">
        <h3 className="font-semibold text-gray-900 mb-4">Claim Details</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Policy Holder:</span>
            <span className="ml-2 text-gray-900 font-medium">{claim.policyHolderName || '-'}</span>
          </div>
          <div>
            <span className="text-gray-500">Relationship:</span>
            <span className="ml-2 text-gray-900 font-medium">{claim.relationship || '-'}</span>
          </div>
          <div>
            <span className="text-gray-500">Date of Death:</span>
            <span className="ml-2 text-gray-900 font-medium">{claim.dateOfDeath || '-'}</span>
          </div>
          <div>
            <span className="text-gray-500">Cause of Death:</span>
            <span className="ml-2 text-gray-900 font-medium">{claim.causeOfDeath || '-'}</span>
          </div>
        </div>
      </div>

      {/* Documents Submitted */}
      <div className="card-flat mb-6">
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-gray-500" />
          Documents Submitted
        </h3>
        {claim.documents && claim.documents.length > 0 ? (
          <div className="space-y-2">
            {claim.documents.map((doc: any, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                  <FileSearch className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{doc.fileName || doc.documentType || `Document ${idx + 1}`}</p>
                  <p className="text-xs text-gray-500">{doc.documentType ? doc.documentType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Supporting Document'}</p>
                </div>
                <span className="text-xs text-emerald-600 font-medium">Uploaded</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-amber-50 rounded-lg px-3 py-2 text-sm text-amber-700">
            No documents uploaded yet. Required: Death Certificate, Beneficiary ID, Medical Records.
          </div>
        )}
      </div>

      {/* Document Verification */}
      {details.document_findings && (
        <div className="card-flat mb-6 border-l-4 border-l-purple-500">
          <div className="flex items-start gap-3">
            <div className="bg-purple-50 rounded-lg p-2">
              <FileSearch className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Document Verification</h3>
              <p className="text-sm text-gray-600 leading-relaxed">{details.document_findings}</p>
            </div>
          </div>
        </div>
      )}

      {/* Claim Timeline */}
      <div className="mb-6">
        <ClaimTimeline claim={claim} />
      </div>

      {/* Document Upload — shown for escalated/denied/resubmitted claims that can be resubmitted */}
      {(['escalated', 'denied', 'resubmitted'].includes((claim.status || '').toLowerCase()) && (claim.resubmissionCount || 0) < 5) && (
        <DocumentUploadSection claimId={claim.claimId} />
      )}

      {/* Resubmit Panel — shown for escalated/denied claims */}
      <div className="mb-6">
        <ResubmitPanel claim={claim} onResubmitted={() => {
          // Refresh claim data after resubmission
          if (claimId) {
            claimsApi.getClaim(claimId).then(setClaim).catch(() => {})
          }
        }} />
      </div>

      {/* Support Resources — shown for military/combat-related denials */}
      {claim.status === 'denied' && claim.causeOfDeath && /military|combat|killed in action|terrorism|war/i.test(claim.causeOfDeath) && (
        <div className="card-flat mb-6 border-l-4 border-l-indigo-500">
          <div className="flex items-start gap-3">
            <div className="bg-indigo-50 rounded-lg p-2">
              <Info className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Support Resources</h3>
              <p className="text-sm text-gray-600 leading-relaxed mb-2">
                We honor your loved one's service and sacrifice. While this policy's coverage terms limit our ability to pay this specific claim, you may be entitled to benefits through other programs:
              </p>
              <ul className="text-sm text-gray-600 space-y-1 ml-4 list-disc">
                <li>Servicemembers' Group Life Insurance (SGLI) — up to $500,000 in coverage for active duty members</li>
                <li>Department of Veterans Affairs (VA) Dependency and Indemnity Compensation (DIC)</li>
                <li>Military Survivor Benefits — contact your Casualty Assistance Officer</li>
              </ul>
              <p className="text-sm text-gray-500 mt-2">
                If you believe this determination was made in error, please contact our dedicated military family support team.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Action Required — shown for escalated or pending claims needing documents */}
      {(() => {
        const s = (claim.status || '').toLowerCase()
        const noDocuments = details.documents_verified === false
        const needsAction = s === 'escalated' || s === 'processing' || s === 'submitted'
        if (!needsAction && !noDocuments) return null

        // Build contextual message
        let title = ''
        let message = ''
        let borderColor = 'border-l-amber-500'
        let bgColor = 'bg-amber-50'
        let iconColor = 'text-amber-600'
        let Icon = AlertTriangle

        if (noDocuments && (s === 'escalated' || s === 'denied')) {
          title = 'Additional Documents Required'
          message = 'Your claim requires supporting documentation to proceed. Please upload the following: a certified death certificate, beneficiary identification (government-issued photo ID), and any relevant medical records. You can upload documents through the Submit Claim page or contact your assigned adjuster for assistance.'
          borderColor = 'border-l-red-500'
          bgColor = 'bg-red-50'
          iconColor = 'text-red-600'
        } else if (s === 'escalated') {
          title = 'Claim Under Review'
          message = 'Your claim has been escalated for additional review by a senior adjuster. This may be due to the claim amount, policy details, or additional verification requirements. If further documents or information are needed, an adjuster will contact you directly. No action is required from you at this time unless otherwise notified.'
          Icon = Info
          borderColor = 'border-l-blue-500'
          bgColor = 'bg-blue-50'
          iconColor = 'text-blue-600'
        } else if (s === 'submitted' || s === 'processing') {
          title = 'Claim Being Processed'
          message = 'Your claim is currently being reviewed. Our system is verifying your submitted documents and policy details. You will be notified once a decision has been made.'
          Icon = Info
          borderColor = 'border-l-blue-500'
          bgColor = 'bg-blue-50'
          iconColor = 'text-blue-600'
        } else {
          return null
        }

        return (
          <div className={`card-flat mb-6 border-l-4 ${borderColor}`}>
            <div className="flex items-start gap-3">
              <div className={`${bgColor} rounded-lg p-2`}>
                <Icon className={`h-5 w-5 ${iconColor}`} />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{message}</p>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

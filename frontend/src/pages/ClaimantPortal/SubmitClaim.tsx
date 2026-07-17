import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { claimsApi } from '@/services/api'
import { FileUp, AlertCircle, X, FileText, Image, File, Zap } from 'lucide-react'

const DOC_TYPES = [
  { value: 'death_certificate', label: 'Death Certificate' },
  { value: 'medical_records', label: 'Medical Records' },
  { value: 'policy_document', label: 'Policy Document' },
  { value: 'beneficiary_id', label: 'Beneficiary ID' },
  { value: 'trust_document', label: 'Trust Document' },
  { value: 'police_report', label: 'Police Report' },
  { value: 'other', label: 'Other' },
]

interface ScenarioData {
  label: string
  description: string
  expectedOutcome: string
  policyNumber: string
  policyHolderName: string
  beneficiaryName: string
  relationship: string
  dateOfDeath: string
  causeOfDeath: string
  claimAmount: string
}

const SCENARIOS: Record<string, ScenarioData> = {
  '': { label: 'Manual Entry', description: '', expectedOutcome: '', policyNumber: '', policyHolderName: '', beneficiaryName: '', relationship: '', dateOfDeath: '', causeOfDeath: '', claimAmount: '' },
  scenario1: {
    label: 'Scenario 1: STP Auto-Approve',
    description: 'Clean low-value claim — natural death, all docs valid',
    expectedOutcome: '✅ Auto-Approved',
    policyNumber: 'LIP-2019-087234',
    policyHolderName: 'Robert James Mitchell',
    beneficiaryName: 'Margaret Anne Mitchell',
    relationship: 'spouse',
    dateOfDeath: '2026-02-10',
    causeOfDeath: 'Acute Myocardial Infarction (Heart Attack)',
    claimAmount: '25000',
  },
  scenario2: {
    label: 'Scenario 2: Auto-Deny (Lapsed Policy)',
    description: 'Policy lapsed 6 months before death',
    expectedOutcome: '❌ Auto-Denied',
    policyNumber: 'LIP-2018-054891',
    policyHolderName: 'Thomas Edward Parker',
    beneficiaryName: 'Jennifer Parker',
    relationship: 'spouse',
    dateOfDeath: '2026-02-18',
    causeOfDeath: 'Cerebrovascular Accident (Stroke)',
    claimAmount: '30000',
  },
  scenario3: {
    label: 'Scenario 3: Auto-Deny (High Fraud)',
    description: 'Suspicious timing, 10x coverage increase, recent beneficiary change',
    expectedOutcome: '❌ Auto-Denied (Fraud)',
    policyNumber: 'LIP-2025-112847',
    policyHolderName: 'Victor Alejandro Reyes',
    beneficiaryName: 'Maria Elena Reyes',
    relationship: 'spouse',
    dateOfDeath: '2026-02-22',
    causeOfDeath: 'Drowning (accidental, BAC 0.18)',
    claimAmount: '45000',
  },
  scenario4: {
    label: 'Scenario 4: Manual Review (High-Value)',
    description: 'Clean claim but amount ≥ $50K triggers human review',
    expectedOutcome: '⏸️ Manual Review',
    policyNumber: 'LIP-2015-023456',
    policyHolderName: 'Elizabeth Grace Thornton',
    beneficiaryName: 'Thornton Family Trust (60%) / Catherine Thornton-Wells (40%)',
    relationship: 'trustee',
    dateOfDeath: '2026-02-08',
    causeOfDeath: 'Metastatic Pancreatic Cancer',
    claimAmount: '150000',
  },
  scenario5: {
    label: 'Scenario 5: Pending Documents',
    description: 'Missing death certificate and medical records',
    expectedOutcome: '📄 Pending Documents',
    policyNumber: 'LIP-2021-078345',
    policyHolderName: 'Andrew Paul Kowalski',
    beneficiaryName: 'Susan Marie Kowalski',
    relationship: 'spouse',
    dateOfDeath: '2026-02-25',
    causeOfDeath: 'Heart Attack (per claimant — unverified)',
    claimAmount: '35000',
  },
  scenario6: {
    label: 'Scenario 6: Auto-Deny (Suicide Exclusion)',
    description: 'Suicide within 2-year contestability period',
    expectedOutcome: '❌ Auto-Denied (Exclusion)',
    policyNumber: 'LIP-2025-098712',
    policyHolderName: 'Daniel James Crawford',
    beneficiaryName: 'Karen Crawford',
    relationship: 'parent',
    dateOfDeath: '2026-02-15',
    causeOfDeath: 'Suicide (intentional self-harm)',
    claimAmount: '40000',
  },
  scenario7: {
    label: 'Scenario 7: Manual Review (Moderate Fraud)',
    description: 'Undisclosed pre-existing conditions, fraud score 0.5–0.8',
    expectedOutcome: '⏸️ Manual Review',
    policyNumber: 'LIP-2023-065478',
    policyHolderName: 'William Henry Foster',
    beneficiaryName: 'Linda Foster (50%) / Mark Foster (50%)',
    relationship: 'spouse',
    dateOfDeath: '2026-02-27',
    causeOfDeath: 'Pneumonia complications from COPD',
    claimAmount: '28000',
  },
  scenario8: {
    label: 'Scenario 8: Grace Period (Should NOT Deny)',
    description: 'Death within 31-day premium grace period - policy still in force',
    expectedOutcome: '\u2705 Approved (grace period applies)',
    policyNumber: 'LIP-2022-034567',
    policyHolderName: 'Samuel Thomas Rivera',
    beneficiaryName: 'Elena Rivera',
    relationship: 'spouse',
    dateOfDeath: '2026-07-18',
    causeOfDeath: 'Cardiac arrest (natural causes)',
    claimAmount: '45000',
  },
  scenario9: {
    label: 'Scenario 9: War/Terrorism Exclusion (Auto-Deny)',
    description: 'Death from military combat - policy exclusion applies',
    expectedOutcome: '\u274c Auto-Denied (Exclusion)',
    policyNumber: 'LIP-2017-089012',
    policyHolderName: 'Marcus Anthony Walsh',
    beneficiaryName: 'Rebecca Walsh',
    relationship: 'spouse',
    dateOfDeath: '2026-06-03',
    causeOfDeath: 'Killed in action during military deployment (combat zone)',
    claimAmount: '50000',
  },
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf' || ext === 'txt') return <FileText className="h-5 w-5 text-red-500" />
  if (['jpg', 'jpeg', 'png'].includes(ext || '')) return <Image className="h-5 w-5 text-blue-500" />
  return <File className="h-5 w-5 text-gray-500" />
}

export default function SubmitClaim() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedScenario, setSelectedScenario] = useState('')
  const [formData, setFormData] = useState({
    policyNumber: '',
    policyHolderName: '',
    beneficiaryName: '',
    relationship: '',
    dateOfDeath: '',
    causeOfDeath: '',
    claimAmount: '',
  })
  const [files, setFiles] = useState<File[]>([])
  const [fileTypes, setFileTypes] = useState<Record<number, string>>({})

  const handleScenarioChange = (scenarioKey: string) => {
    setSelectedScenario(scenarioKey)
    if (scenarioKey && SCENARIOS[scenarioKey]) {
      const s = SCENARIOS[scenarioKey]
      setFormData({
        policyNumber: s.policyNumber,
        policyHolderName: s.policyHolderName,
        beneficiaryName: s.beneficiaryName,
        relationship: s.relationship,
        dateOfDeath: s.dateOfDeath,
        causeOfDeath: s.causeOfDeath,
        claimAmount: s.claimAmount,
      })
    }
  }

  const submitMutation = useMutation({
    mutationFn: async (data: any) => {
      const claim = await claimsApi.submitClaim(data)
      if (files.length > 0) {
        await claimsApi.uploadDocuments(claim.claimId, files)
      }
      return claim
    },
    onSuccess: (claim) => {
      navigate(`/claimant/${claim.claimId}`)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submitMutation.mutate({
      ...formData,
      claimAmount: parseFloat(formData.claimAmount),
      submittedAt: Date.now(),
      documentTypes: files.map((_, i) => fileTypes[i] || 'other'),
    })
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files)
      setFiles((prev) => [...prev, ...newFiles])
      const startIdx = files.length
      const newTypes: Record<number, string> = {}
      newFiles.forEach((file, i) => {
        const name = file.name.toLowerCase()
        if (name.includes('death_cert') || name.includes('death-cert')) newTypes[startIdx + i] = 'death_certificate'
        else if (name.includes('medical') || name.includes('hospital')) newTypes[startIdx + i] = 'medical_records'
        else if (name.includes('policy')) newTypes[startIdx + i] = 'policy_document'
        else if (name.includes('beneficiary') || name.includes('id') || name.includes('license')) newTypes[startIdx + i] = 'beneficiary_id'
        else if (name.includes('trust')) newTypes[startIdx + i] = 'trust_document'
        else if (name.includes('police')) newTypes[startIdx + i] = 'police_report'
        else newTypes[startIdx + i] = 'other'
      })
      setFileTypes((prev) => ({ ...prev, ...newTypes }))
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setFileTypes((prev) => {
      const updated: Record<number, string> = {}
      Object.entries(prev).forEach(([k, v]) => {
        const key = parseInt(k)
        if (key < index) updated[key] = v
        else if (key > index) updated[key - 1] = v
      })
      return updated
    })
  }

  const updateFileType = (index: number, type: string) => {
    setFileTypes((prev) => ({ ...prev, [index]: type }))
  }

  const scenario = selectedScenario ? SCENARIOS[selectedScenario] : null

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Submit Death Benefits Claim</h1>
        <p className="text-gray-600 mt-2">Complete the form below to submit your death benefits claim</p>
      </div>

      {/* Scenario Quick-Fill */}
      <div className="card mb-6 border-2 border-dashed border-primary-200 bg-primary-50/30">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-5 w-5 text-primary-600" />
          <span className="font-semibold text-primary-900">Demo Quick-Fill</span>
        </div>
        <select
          className="input"
          value={selectedScenario}
          onChange={(e) => handleScenarioChange(e.target.value)}
          aria-label="Select test scenario"
        >
          <option value="">— Select a test scenario to auto-fill —</option>
          {Object.entries(SCENARIOS).filter(([k]) => k !== '').map(([key, s]) => (
            <option key={key} value={key}>{s.label}</option>
          ))}
        </select>
        {scenario && (
          <div className="mt-3 text-sm">
            <p className="text-gray-700">{scenario.description}</p>
            <p className="mt-1 font-medium">Expected: {scenario.expectedOutcome}</p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="card space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="label">Policy Number</label>
            <input type="text" className="input" placeholder="e.g. LIP-2019-087234"
              value={formData.policyNumber}
              onChange={(e) => setFormData({ ...formData, policyNumber: e.target.value })}
              required />
          </div>
          <div>
            <label className="label">Policy Holder Name (Deceased)</label>
            <input type="text" className="input"
              value={formData.policyHolderName}
              onChange={(e) => setFormData({ ...formData, policyHolderName: e.target.value })}
              required />
          </div>
          <div>
            <label className="label">Beneficiary Name (You)</label>
            <input type="text" className="input"
              value={formData.beneficiaryName}
              onChange={(e) => setFormData({ ...formData, beneficiaryName: e.target.value })}
              required />
          </div>
          <div>
            <label className="label">Relationship to Deceased</label>
            <select className="input"
              value={formData.relationship}
              onChange={(e) => setFormData({ ...formData, relationship: e.target.value })}
              required>
              <option value="">Select...</option>
              <option value="spouse">Spouse</option>
              <option value="child">Child</option>
              <option value="parent">Parent</option>
              <option value="sibling">Sibling</option>
              <option value="trustee">Trustee</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Date of Death</label>
            <input type="date" className="input"
              value={formData.dateOfDeath}
              onChange={(e) => setFormData({ ...formData, dateOfDeath: e.target.value })}
              required />
          </div>
          <div>
            <label className="label">Claim Amount ($)</label>
            <input type="number" className="input"
              value={formData.claimAmount}
              onChange={(e) => setFormData({ ...formData, claimAmount: e.target.value })}
              required />
          </div>
        </div>

        <div>
          <label className="label">Cause of Death</label>
          <textarea className="input" rows={3}
            value={formData.causeOfDeath}
            onChange={(e) => setFormData({ ...formData, causeOfDeath: e.target.value })}
            required />
        </div>

        {/* Document Upload Section */}
        <div>
          <label className="label">Supporting Documents</label>
          <p className="text-xs text-gray-500 mb-2">
            Upload death certificate, medical records, policy documents, beneficiary ID, and any other supporting documents.
          </p>
          <div
            className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-lg hover:border-primary-400 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation()
              if (e.dataTransfer.files) {
                setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)])
              }
            }}
          >
            <div className="space-y-1 text-center">
              <FileUp className="mx-auto h-12 w-12 text-gray-400" />
              <div className="text-sm text-gray-600">
                <span className="font-medium text-primary-600 hover:text-primary-500">Click to upload</span>{' '}or drag and drop
              </div>
              <p className="text-xs text-gray-500">PDF, TXT, JPG, PNG up to 10MB each. Select multiple files at once.</p>
              <input ref={fileInputRef} type="file" className="sr-only" multiple
                onChange={handleFileChange} accept=".pdf,.txt,.jpg,.jpeg,.png" />
            </div>
          </div>

          {files.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium text-gray-700">{files.length} document{files.length !== 1 ? 's' : ''} selected:</p>
              {files.map((file, index) => (
                <div key={index} className="flex items-center gap-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
                  {getFileIcon(file.name)}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                    <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                  </div>
                  <select className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                    value={fileTypes[index] || 'other'}
                    onChange={(e) => updateFileType(index, e.target.value)}
                    aria-label={`Document type for ${file.name}`}>
                    {DOC_TYPES.map((dt) => (
                      <option key={dt.value} value={dt.value}>{dt.label}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeFile(index)}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                    aria-label={`Remove ${file.name}`}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                + Add more documents
              </button>
            </div>
          )}
        </div>

        {submitMutation.error && (
          <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle className="h-5 w-5" />
            <span>Failed to submit claim. Please try again.</span>
          </div>
        )}

        <div className="flex gap-4">
          <button type="submit" className="btn-primary flex-1" disabled={submitMutation.isPending}>
            {submitMutation.isPending ? 'Submitting...' : 'Submit Claim'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/claimant')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

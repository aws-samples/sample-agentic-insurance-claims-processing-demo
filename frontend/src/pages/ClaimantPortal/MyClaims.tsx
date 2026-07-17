import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { claimsApi } from '@/services/api'
import { FileText, Plus, Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react'

export default function MyClaims() {
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const fetchClaims = async () => {
    try {
      const data = await claimsApi.getClaims()
      setClaims(Array.isArray(data) ? data : data.claims || [])
    } catch (error) {
      console.error('Failed to fetch claims:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchClaims() }, [])

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'approved': return <CheckCircle className="h-4 w-4 text-emerald-500" />
      case 'denied': return <XCircle className="h-4 w-4 text-red-500" />
      default: return <Clock className="h-4 w-4 text-amber-500" />
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'approved': return 'badge-success'
      case 'denied': return 'badge-danger'
      default: return 'badge-warning'
    }
  }

  const formatDate = (epoch: number) => {
    if (!epoch) return '-'
    return new Date(epoch * 1000).toLocaleDateString()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 text-primary-500 animate-spin" />
        <span className="ml-3 text-gray-500">Loading claims...</span>
      </div>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="page-title">My Claims</h2>
          <p className="page-subtitle">{claims.length} total claims</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/claimant/submit" className="btn-primary flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Submit New Claim
          </Link>
        </div>
      </div>

      {claims.length === 0 ? (
        <div className="card text-center py-16">
          <div className="bg-primary-50 rounded-full p-4 w-16 h-16 mx-auto mb-4 flex items-center justify-center">
            <FileText className="h-8 w-8 text-primary-500" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No claims yet</h3>
          <p className="text-gray-500 mb-6">Submit your first claim to get started with the process.</p>
          <Link to="/claimant/submit" className="btn-primary inline-flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Submit New Claim
          </Link>
        </div>
      ) : (
        <div className="card-flat overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr className="bg-gray-50/80">
                <th className="px-6 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Claim ID</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {claims.map((claim: any) => (
                <tr key={claim.claimId} className="hover:bg-primary-50/30 transition-colors">
                  <td className="px-6 py-4">
                    <Link to={`/claimant/${claim.claimId}`} className="text-primary-600 hover:text-primary-800 font-medium">
                      {claim.claimId}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">${claim.claimAmount?.toLocaleString() || '-'}</td>
                  <td className="px-6 py-4">
                    <span className={`${getStatusBadge(claim.status)} flex items-center gap-1.5 w-fit`}>
                      {getStatusIcon(claim.status)}
                      {claim.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{formatDate(claim.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

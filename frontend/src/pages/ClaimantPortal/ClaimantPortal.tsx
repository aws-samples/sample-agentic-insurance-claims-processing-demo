import { Routes, Route } from 'react-router-dom'
import SubmitClaim from './SubmitClaim'
import MyClaims from './MyClaims'
import ClaimDetails from './ClaimDetails'

export default function ClaimantPortal() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Routes>
        <Route index element={<MyClaims />} />
        <Route path="submit" element={<SubmitClaim />} />
        <Route path=":claimId" element={<ClaimDetails />} />
      </Routes>
    </div>
  )
}

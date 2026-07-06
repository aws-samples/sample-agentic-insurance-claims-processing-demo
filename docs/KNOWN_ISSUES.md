# Known Issues and Deployment Lessons Learned

This document captures issues encountered during deployment and their resolutions.
For the full troubleshooting log (27 lessons), see [DEPLOYMENT ARTIFACTS/03_TROUBLESHOOTING.md](../DEPLOYMENT%20ARTIFACTS/03_TROUBLESHOOTING.md).

---

## 1. OpenSearch Serverless Index Creation Fails with 404

**Symptom:** CDK custom resource fails with `Failed to create index policy-guidelines-index: 404` during `LifeInsuranceInfraStack` deployment.

**Root Cause:** OpenSearch Serverless has a race condition where the collection reports as created in CloudFormation but isn't fully ready to accept API requests. Even with 180-second waits and retries, timing is unpredictable.

**Fix:** Run `create_indices.py` separately after the collection reaches `ACTIVE` status:

```bash
# Wait for collection to be ACTIVE
aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].[name,status]' \
  --output table

# Create indices manually
python3 backend/infrastructure/create_indices.py
```

**Prevention:** Deploy CDK stacks and run index creation in parallel as documented in the deployment guide. The `create_indices.py` script polls for collection readiness automatically.

---

## 2. AgentCore ECR Permissions Error on Runtime Creation

**Symptom:**
```
ValidationException: Access denied while validating ECR URI '...'
The execution role requires permissions for ecr:GetAuthorizationToken,
ecr:BatchGetImage, and ecr:GetDownloadUrlForLayer operations.
```

**Root Cause:** IAM role propagation delay. The CDK-created role needs time to propagate before AgentCore can validate ECR permissions.

**Fix:** Wait 30-60 seconds and retry the CDK deploy. The agent stack includes retry logic, but in rare cases a full redeploy is needed:

```bash
cdk deploy LifeInsuranceAgentStack --require-approval never
```

**Prevention:** The CDK agent stack now includes a propagation wait custom resource between role creation and runtime creation.

---

## 3. Frontend Shows CORS Error on API Calls

**Symptom:** `Access blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`

**Root Cause:** Two possible causes:
1. API Gateway CORS preflight (OPTIONS) not configured for the endpoint
2. Lambda returning an error response without CORS headers

**Fix:**
```bash
# Redeploy API stack to refresh CORS configuration
cd backend/infrastructure
cdk deploy LifeInsuranceApiStack --require-approval never
```

**Prevention:** Ensure all Lambda response paths (including error handlers) include CORS headers. The `CORS_HEADERS` constant should be used in all `response()` calls.

---

## 4. Claims Stuck in "Submitted" Status (AI Processing Not Starting)

**Symptom:** Claim shows "Submitted" status indefinitely, never transitions to "Processing" or a final decision.

**Root Cause:** The async self-invocation pattern (`InvocationType='Event'`) can silently fail if:
1. Lambda doesn't have invoke permission on itself
2. The `SUPERVISOR_RUNTIME_ARN` environment variable is empty/invalid
3. Bedrock model access not granted in the account

**Fix:**
```bash
# Check Lambda logs for errors
aws logs tail /aws/lambda/LifeInsuranceClaimsHandler --follow

# Verify Bedrock model access
aws bedrock list-foundation-models --query "modelSummaries[?modelId=='anthropic.claude-sonnet-4-20250514-v1:0'].modelId"
```

**Prevention:** Run `scripts/deploy.sh` which validates all prerequisites. Ensure Claude Sonnet 4 model access is enabled in the Bedrock console before deployment.

---

## 5. Cognito redirect_mismatch Error on Login

**Symptom:** Login redirects to Cognito but returns `error=redirect_mismatch`.

**Root Cause:** The Cognito app client's callback URLs don't match the CloudFront distribution URL. This happens when redeploying to a different account or when CloudFront assigns a new domain.

**Fix:**
```bash
# Get your CloudFront domain
FRONTEND_URL=$(aws cloudformation describe-stacks \
  --stack-name LifeInsuranceInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`FrontendURL`].OutputValue' \
  --output text)

# Update Cognito callback URLs (get values from outputs.json)
aws cognito-idp update-user-pool-client \
  --user-pool-id <USER_POOL_ID> \
  --client-id <CLIENT_ID> \
  --callback-urls "[\"${FRONTEND_URL}/\"]" \
  --logout-urls "[\"${FRONTEND_URL}/\"]" \
  --supported-identity-providers COGNITO \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client
```

**Prevention:** The CDK stack should derive callback URLs from the CloudFront distribution domain. Verify after each fresh deployment.

---

## 6. CodeBuild Fails During Agent Docker Image Build

**Symptom:** CDK deployment hangs for 10+ minutes then fails with CodeBuild timeout or image build errors.

**Root Cause:** CodeBuild builds ARM64 Docker images for all 6 agents sequentially. Network issues, pip install failures, or base image pull limits can cause timeouts.

**Fix:**
```bash
# Check CodeBuild logs
aws codebuild list-builds-for-project --project-name LifeInsuranceAgentBuild
aws codebuild batch-get-builds --ids <BUILD_ID> --query 'builds[0].phases'

# Retry deployment
cdk deploy LifeInsuranceAgentStack --require-approval never
```

**Prevention:** Ensure stable network connectivity during deployment. The CodeBuild project has a 30-minute timeout configured.

---

## 7. Knowledge Base Ingestion Fails

**Symptom:** `sync_knowledge_bases.py` reports errors or Knowledge Bases show 0 documents after sync.

**Root Cause:** Either S3 data wasn't uploaded before sync, or the OpenSearch indices don't exist yet.

**Fix:**
```bash
# Verify data is in S3
aws s3 ls s3://life-insurance-kb-$(aws sts get-caller-identity --query Account --output text)-us-east-1/policy-guidelines/

# If empty, reload
cd backend/knowledge-bases
python3 load_knowledge_bases.py
python3 sync_knowledge_bases.py
```

**Prevention:** Always run `load_knowledge_bases.py` before `sync_knowledge_bases.py`. Ensure OpenSearch indices are created first (see Issue #1).

---

---

## FSI Edge Cases — Claims Processing Industry Scenarios

The following edge cases are common in life insurance death benefits claims processing. Some are handled by the current system, others are documented for future implementation.

### Currently Handled

| Edge Case | How It's Handled | Scenario |
|-----------|-----------------|----------|
| Lapsed policy | Auto-deny, no coverage in force | Scenario 2 |
| Suicide within contestability | Auto-deny citing exclusion clause | Scenario 6 |
| High fraud indicators | Auto-deny when score >= 0.7 with multiple red flags | Scenario 3 |
| Beneficiary mismatch | Escalate for legal standing verification | Scenario 8 |
| Missing documents | Deterministic S3 check escalates immediately | Scenario 5 |
| High-value claims | Escalate for senior adjuster sign-off (>= $100K) | Scenario 4 |
| Undisclosed pre-existing conditions | Moderate fraud score, escalate for human review | Scenario 7 |
| Multiple beneficiaries / Trust | AI recognizes split designations and trust names | Scenario 4 |
| Resubmission after escalation | Claimant uploads missing docs and resubmits for re-evaluation | Built-in flow |

### Not Yet Handled — Future Implementation

| Edge Case | Industry Relevance | Effort | Description |
|-----------|-------------------|--------|-------------|
| **Minor beneficiary** | High | Medium (2-3 days) | Claimant under 18 requires legal guardian/custodian to file. Needs: age field on form, guardian relationship field, court appointment documentation, UTMA/UGMA custodial account routing. AI rule: if beneficiary age < 18 → escalate with "Minor beneficiary — requires court-appointed guardian documentation." |
| **Simultaneous death (common disaster)** | Medium | Low (0.5 day) | Both insured and primary beneficiary die in same event (car accident, natural disaster). Contingent beneficiary rules apply. AI prompt addition: if death certificate indicates multiple deaths in same incident and beneficiary matches a deceased party → escalate for contingent beneficiary determination. |
| **Delayed reporting (death > 1 year ago)** | Medium | Low (0.5 day) | Death occurred more than 12 months before claim submission. Flag for investigation — may indicate fraud or estate complications. Code check: compare dateOfDeath against submittedAt; if gap > 365 days → add to fraud indicators and escalate. |
| **International death (out-of-country)** | Medium | Low (0.5 day) | Death occurred outside the US. Different document requirements: foreign death certificate may need apostille/translation, consulate verification. AI prompt note: if death certificate indicates foreign jurisdiction → escalate noting additional document requirements. |
| **Disputed beneficiary (multiple claimants)** | High | Low (1 day) | Multiple people file claims on the same policy. System needs to detect duplicate policy numbers across active claims and escalate all of them for legal review. Code check: query DynamoDB for existing claims with same policyNumber. |
| **Misstatement of age** | Medium | Low (0.5 day) | Policy holder's actual age differs from application age. Payout is adjusted proportionally (what premiums would have bought at correct age). AI prompt rule: if documents reveal age discrepancy from policy records → escalate with adjustment calculation. |
| **War/terrorism exclusion** | Medium | Low (0.5 day) | Some policies exclude death from acts of war or terrorism. AI prompt addition: if cause of death indicates military action, terrorism, or armed conflict → check policy exclusions and deny if exclusion applies. |
| **Accidental death & dismemberment (AD&D)** | High | Medium (1-2 days) | Separate AD&D rider pays additional benefit for accidental death. Needs: AD&D rider field in policy database, separate payout calculation, AI must distinguish accidental vs natural and apply correct coverage amount. |
| **Assignment/collateral claims** | High | Medium (2 days) | Bank or lender holds a lien on the policy (used as collateral for a loan). Payout must satisfy the lien before beneficiary receives remainder. Needs: lien field in policy database, split payout logic, third-party notification. |
| **Felony exclusion** | Low | Low (0.5 day) | Death during commission of a felony may be excluded. AI prompt addition: if cause of death or police report indicates criminal activity by the insured → check policy felony exclusion clause. |
| **Interpleader (conflicting claims)** | Medium | Medium (2 days) | Insurance company deposits funds with the court when multiple parties claim the same benefit and lets the court decide. System would need to detect conflicts and trigger legal hold. |
| **Grace period death** | Medium | Low (0.5 day) | Policy holder dies during the premium grace period (typically 31 days after missed payment). Policy is still in force — should NOT be treated as lapsed. AI rule: if last premium date + 31 days >= date of death → policy is still active despite missed payment. |

### Implementation Priority (Recommended Order)

**Quick wins (add to AI prompt rules, no code changes needed):**
1. Grace period death — prevents false lapse denials
2. Simultaneous death — common disaster clause
3. War/terrorism exclusion — policy exclusion check
4. Misstatement of age — adjustment escalation
5. International death — flag for additional docs

**Short-term (simple code checks):**
6. Delayed reporting — date comparison in ProcessClaimHandler
7. Disputed beneficiary — duplicate policy number check

**Medium-term (new form fields or data model changes):**
8. Minor beneficiary — age field, guardian docs
9. AD&D rider — policy database field, payout logic
10. Assignment/collateral — lien field, split payout

---

## 8. New Scenarios Not Found by AgentCore Supervisor

**Symptom:** New demo scenarios (e.g., Scenario 8 Grace Period) get denied with "NO RECORD FOUND for policy" and a fraud score of 0.8, even though the policy exists in `claims_handler.py`.

**Root Cause:** `POLICY_DATABASE` exists in TWO files:
1. `backend/lambda/claims/claims_handler.py` — used by the Bedrock direct fallback path and imported by `process_claim_handler.py`
2. `backend/agents/supervisor/supervisor.py` — baked into the AgentCore Docker image

When new scenarios are added to `claims_handler.py` only, the Supervisor agent (running on AgentCore) doesn't see them because its Docker image has the old copy.

**Fix:** When adding new demo scenarios, update `POLICY_DATABASE` in BOTH files:
```bash
# 1. Add the new policy to both files
# 2. Redeploy the Agent stack to rebuild Docker images
cd backend/infrastructure
npx aws-cdk@latest deploy LifeInsuranceAgentStack --exclusively --require-approval never
```

**Prevention:** Consider refactoring `POLICY_DATABASE` into a shared module or loading it from DynamoDB/S3 so both paths use the same source of truth. For now, always update both files when adding scenarios.

# CCOE Insurance Industry LLC — Demo Testing Guide

This guide walks through each test scenario step by step, explaining what happens at each stage of the AI-powered claims processing pipeline.

---

## Prerequisites

1. All CDK stacks deployed and healthy
2. Test data loaded:
   ```bash
   cd test-data
   python3 load_test_data.py
   ```
3. Frontend deployed at CloudFront URL from `outputs.json`
4. Test users created:
   - `claimant1` / `Test123!Pass` — Claimant role
   - `adjuster1` / `Test123!Pass` — Adjuster role
   - `business1` / `Test123!Pass` — Business user role

---

## How the Processing Pipeline Works

When a claim is submitted, the Claims Lambda processes it through the following pipeline:

```
Claim Submitted (via portal or Demo Quick-Fill)
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  1. Claims Lambda (Synchronous)                         │
│     - Creates claim record in DynamoDB (status: submitted)│
│     - Self-invokes asynchronously (InvocationType='Event')│
│     - Returns claim ID to frontend immediately           │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  2. Async Claims Lambda                                 │
│     - Updates status to 'processing'                    │
│     - Waits 5s for document uploads to complete         │
│     - Fetches uploaded documents from S3                │
│     - Looks up policy from POLICY_DATABASE               │
│     - Tries AgentCore Supervisor (primary)              │
│     - Falls back to Bedrock InvokeModel (if needed)     │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  3a. AgentCore Supervisor (PRIMARY PATH)                │
│     4-phase parallel pipeline:                          │
│     Phase 1 (parallel): Authenticate + Extract          │
│     Phase 2 (parallel): Policy Verify + Fraud Detect    │
│     Phase 3: Adjudicate (all prior results)             │
│     Phase 4: Synthesize final JSON (single LLM call)    │
│     Total: ~74s estimated                               │
│                                                         │
│  3b. Bedrock InvokeModel (FALLBACK PATH)                │
│     Claude Sonnet 4 — single prompt with all context    │
│     Total: ~2-10s                                       │
│                                                         │
│     Returns JSON:                                       │
│     { decision, confidence, reasoning, fraud_score,     │
│       policy_valid, authentication_passed,              │
│       documents_verified, document_findings,            │
│       processing_steps }                                │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  4. DynamoDB Update                                     │
│     - Status set to: approved / denied / escalated      │
│     - aiInsights = reasoning text                       │
│     - processingDetails = full JSON response            │
│     - processing_path = agentcore / bedrock_direct      │
└─────────────────────────────────────────────────────────┘
```

**Decision Rules (enforced in AI prompt)**:
- **Auto-Approve**: fraud_score < 0.3 AND policy active AND all docs valid AND amount < $100,000
- **Auto-Deny**: policy lapsed OR excluded cause of death OR fraud_score >= 0.7
- **Escalate to Human**: amount ≥ $100,000 OR fraud_score 0.5–0.7 OR missing documents OR beneficiary disputes

**Architecture Note**: 6 specialist agents (Supervisor, Authenticator, Extractor, PolicyVerification, FraudDetection, Adjudication) are deployed on Bedrock AgentCore as ECR-based ARM64 containers built via CodeBuild. The Supervisor orchestrates specialists in a 4-phase parallel pipeline using `ThreadPoolExecutor`. The Claims Lambda tries AgentCore Supervisor first, falling back to direct Bedrock InvokeModel if AgentCore is unavailable.

## Using the Demo Quick-Fill Feature

The Submit Claim page includes a "Demo Quick-Fill" dropdown at the top of the form. Selecting any of the 7 scenarios auto-fills all form fields:

1. Select a scenario from the dropdown
2. All fields populate automatically (policy number, holder name, beneficiary, relationship, date of death, cause of death, claim amount)
3. The expected outcome is shown below the dropdown
4. Optionally upload matching documents from `test-data/documents/`
5. Click "Submit Claim"

This makes it fast to demonstrate all 7 scenarios during a live demo.

---

## Scenario 1: STP Auto-Approve (Clean Low-Value Claim)

**Claim ID**: CLM-DEMO-001
**Expected Outcome**: Approved automatically (Straight-Through Processing)

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2019-087234 |
| Policy Holder | Robert James Mitchell |
| Beneficiary | Margaret Anne Mitchell (Spouse) |
| Date of Death | February 10, 2026 |
| Cause of Death | Acute Myocardial Infarction (Heart Attack) |
| Claim Amount | $25,000 |
| Documents | Death certificate, policy document, beneficiary ID, medical records |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Validates Margaret Mitchell as the named primary beneficiary on the policy
- Confirms spousal relationship matches policy designation
- Checks beneficiary ID (CT driver's license) — valid, address matches policy
- Expected output: `authenticated: true`, `confidence_score: 0.95+`

**Step 2 — Extractor Agent**
- Processes death certificate via Textract: extracts date of death (Feb 10, 2026), cause (MI), manner (Natural), certifying physician
- Processes medical records: extracts hospital admission, diagnosis codes, treatment timeline
- Processes policy document: extracts policy number, status, coverage amount, beneficiary
- Cross-references extracted data across documents for consistency
- Expected output: `completeness_score: 0.95+`, no missing fields

**Step 3 — Policy Verification Agent**
- Policy LIP-2019-087234: Active, in force since June 2019
- Premiums current (paid through March 2026)
- Face amount $250,000 — claim of $25,000 is within coverage
- Contestability period expired (policy > 2 years)
- No exclusions apply — natural cause of death
- Expected output: `policy_active: true`, `verification_passed: true`

**Step 4 — Fraud Detection Agent**
- Policy age: 7 years — no recent purchase red flag
- No beneficiary changes
- Cause of death consistent with medical history (CAD, hypertension, diabetes)
- Claim amount well below face value — no over-claiming
- Expected output: `fraud_risk_score: 0.05–0.15`, `risk_level: low`

**Step 5 — Adjudication Agent**
- All criteria met for auto-approve: fraud < 0.3 ✓, policy active ✓, docs complete ✓, amount < $100K ✓
- Payout: $25,000 to Margaret Anne Mitchell
- Expected output: `decision: approve`, `payout_amount: 25000`

### How to Verify
1. Login as `claimant1` → Claimant Portal → find CLM-DEMO-001
2. Status should progress: Submitted → Authenticating → Extracting → Verifying Policy → Fraud Check → Approved
3. Login as `adjuster1` → Adjuster Workbench → claim should show as auto-approved with AI reasoning
4. Check DynamoDB directly:
   ```bash
   aws dynamodb get-item --table-name <ClaimsTable> \
     --key '{"claimId":{"S":"CLM-DEMO-001"}}' \
     --query "Item.[status,processingDetails,adjudicationResult]"
   ```

---

## Scenario 2: Auto-Deny (Lapsed Policy)

**Claim ID**: CLM-DEMO-002
**Expected Outcome**: Denied automatically

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2018-054891 |
| Policy Holder | Thomas Edward Parker |
| Beneficiary | Jennifer Parker (Ex-Spouse) |
| Date of Death | February 18, 2026 |
| Cause of Death | Cerebrovascular Accident (Stroke) |
| Claim Amount | $30,000 |
| Documents | Death certificate, policy document |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Jennifer Parker is listed as primary beneficiary — but note: she is the ex-spouse
- Divorce finalized April 2024, beneficiary designation never updated
- This is a valid concern but not a denial reason on its own
- Expected output: `authenticated: true`, `confidence_score: 0.70–0.80`, concern flagged about outdated beneficiary

**Step 2 — Extractor Agent**
- Extracts death certificate data: stroke, atrial fibrillation, chronic alcoholism
- Extracts policy document: clearly shows LAPSED status, last premium July 2025
- Expected output: `completeness_score: 0.85`, flags policy lapse prominently

**Step 3 — Policy Verification Agent**
- Policy LIP-2018-054891: **LAPSED — NOT IN FORCE**
- Last premium paid: July 1, 2025
- Grace period ended: August 31, 2025
- Policy lapsed: September 1, 2025 (6 months before death)
- Three notices were sent to policyholder
- Reinstatement not eligible (> 6 months lapsed)
- Expected output: `policy_active: false`, `premium_status: lapsed`, `verification_passed: false`

**Step 4 — Fraud Detection Agent**
- No fraud indicators per se — this is a legitimate death
- However, filing a claim on a lapsed policy is noted
- Expected output: `fraud_risk_score: 0.20–0.30`, `risk_level: low`

**Step 5 — Adjudication Agent**
- Auto-deny triggered: policy lapsed
- No death benefit payable per policy terms
- Expected output: `decision: deny`, `reasoning: Policy lapsed September 1, 2025. No coverage in force at time of death.`

### How to Verify
1. Login as `claimant1` → find CLM-DEMO-002 → status should show Denied
2. Login as `adjuster1` → denial reasoning should cite lapsed policy with specific dates
3. The denial is immediate once policy verification confirms lapse — no need for full fraud analysis

---

## Scenario 3: Auto-Deny (High Fraud Indicators)

**Claim ID**: CLM-DEMO-003
**Expected Outcome**: Denied automatically (fraud score > 0.8)

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2025-112847 |
| Policy Holder | Victor Alejandro Reyes |
| Beneficiary | Maria Elena Reyes (Spouse) |
| Date of Death | February 22, 2026 |
| Cause of Death | Drowning (accidental, BAC 0.18) |
| Claim Amount | $45,000 |
| Documents | Death certificate, policy document |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Maria Elena Reyes is listed as primary beneficiary — but was only added 45 days before death
- Original beneficiary was Carlos Reyes (brother)
- Expected output: `confidence_score: 0.60–0.70`, concerns about recent beneficiary change

**Step 2 — Extractor Agent**
- Death certificate: drowning, accidental, high BAC (0.18), no autopsy per family request
- Policy document: purchased only 83 days before death, 10x coverage increase from prior policy
- Expected output: flags multiple inconsistencies and suspicious timing

**Step 3 — Policy Verification Agent**
- Policy is technically active and in force
- Within 2-year contestability period (83 days old)
- Previous $50K policy cancelled and replaced with $500K policy 16 days later
- Expected output: `policy_active: true`, but flags contestability and coverage increase

**Step 4 — Fraud Detection Agent**
- This is where the claim gets flagged hard. Red flags:
  - Policy purchased 83 days before death
  - Coverage increased from $50K to $500K (10x)
  - Beneficiary changed from brother to spouse 45 days before death
  - Accidental drowning with high BAC — no autopsy performed
  - Family declined autopsy
  - Within contestability period
- Expected output: `fraud_risk_score: 0.85–0.95`, `risk_level: extreme`

**Step 5 — Adjudication Agent**
- Auto-deny triggered: fraud_score > 0.8
- Recommends investigation by Special Investigations Unit (SIU)
- Expected output: `decision: deny`, detailed reasoning citing all fraud indicators

### How to Verify
1. Login as `adjuster1` → CLM-DEMO-003 should show Denied with extensive fraud analysis
2. The AI reasoning should list each red flag with explanation
3. This scenario demonstrates the system's ability to detect coordinated fraud patterns

---

## Scenario 4: Manual Review (High-Value Claim)

**Claim ID**: CLM-DEMO-004
**Expected Outcome**: Escalated to human adjuster for review

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2015-023456 |
| Policy Holder | Elizabeth Grace Thornton |
| Beneficiary | Thornton Family Trust (60%) / Catherine Thornton-Wells (40%) |
| Date of Death | February 8, 2026 |
| Cause of Death | Metastatic Pancreatic Cancer |
| Claim Amount | $150,000 |
| Documents | Death certificate, policy document |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Beneficiary is a family trust + daughter — both listed on policy
- Trust EIN and daughter identity need verification
- Expected output: `confidence_score: 0.80–0.85`, note about trust verification

**Step 2 — Extractor Agent**
- Death certificate: pancreatic cancer, natural causes, certified by oncologist at Memorial Sloan Kettering
- Policy document: active since 2015, $750K face value, premiums current
- Expected output: `completeness_score: 0.90`, clean extraction

**Step 3 — Policy Verification Agent**
- Policy active since April 2015 — 11 years in force
- Premiums current, $750K face value
- Contestability expired long ago
- No exclusions apply — cancer is a natural cause
- Expected output: `policy_active: true`, `verification_passed: true`

**Step 4 — Fraud Detection Agent**
- Long-standing policy (11 years) — no timing concerns
- No beneficiary changes
- Cause of death consistent with documented medical condition
- Expected output: `fraud_risk_score: 0.05–0.10`, `risk_level: low`

**Step 5 — Adjudication Agent**
- Everything checks out EXCEPT: claim amount $150,000 ≥ $100,000 threshold
- Per company policy, high-value claims require senior adjuster review regardless of AI assessment
- AI provides its recommendation (approve) but escalates for human sign-off
- Expected output: `decision: human_review`, `reasoning: Claim meets all approval criteria but exceeds $100K threshold requiring senior adjuster review`

### How to Verify
1. Login as `claimant1` → CLM-DEMO-004 → status should show Pending Review
2. Login as `adjuster1` → claim appears in review queue with AI recommendation to approve
3. Adjuster can see all agent outputs and make the final call (approve/deny buttons)
4. This demonstrates the human-in-the-loop design for high-value decisions

---

## Scenario 5: Pending Documents (Missing Death Certificate)

**Claim ID**: CLM-DEMO-005
**Expected Outcome**: Held pending additional documentation

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2021-078345 |
| Policy Holder | Andrew Paul Kowalski |
| Beneficiary | Susan Marie Kowalski (Spouse) |
| Date of Death | February 25, 2026 |
| Cause of Death | Heart Attack (per claimant — unverified) |
| Claim Amount | $35,000 |
| Documents | Claim form only (no death certificate, no medical records) |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Claim form lists Susan as spouse — matches expected beneficiary
- However, cannot fully verify without supporting documents
- Expected output: `confidence_score: 0.50–0.60`, flags missing documentation

**Step 2 — Extractor Agent**
- Only has the claim form to process
- No death certificate to extract cause of death, date, certifying physician
- No medical records to extract diagnosis or treatment history
- Expected output: `completeness_score: 0.25–0.35`, `missing_fields: [death_certificate, medical_records]`

**Step 3 — Policy Verification Agent**
- Can check policy status based on policy number
- Policy LIP-2021-078345 should be verifiable as active/inactive
- But cannot cross-reference cause of death against exclusions without death certificate
- Expected output: partial verification only

**Step 4 — Fraud Detection Agent**
- Cannot perform full analysis without death certificate and medical records
- Missing documents itself is a flag (not fraud, but incomplete)
- Expected output: `fraud_risk_score: 0.30–0.40` (elevated due to uncertainty, not fraud)

**Step 5 — Adjudication Agent**
- Cannot auto-approve: missing critical documents
- Escalation triggered: missing documents rule
- Expected output: `decision: human_review` or status set to `pending_documents`
- System should request: death certificate, medical records

### How to Verify
1. Login as `claimant1` → CLM-DEMO-005 → status should show Pending Documents
2. The system should indicate which documents are needed
3. Login as `adjuster1` → claim shows what's missing and what's been received
4. This demonstrates the system's ability to identify incomplete submissions and request specific documents

---

## Scenario 6: Auto-Deny (Suicide Exclusion Within Contestability)

**Claim ID**: CLM-DEMO-006
**Expected Outcome**: Denied automatically (excluded cause + material misrepresentation)

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2025-098712 |
| Policy Holder | Daniel James Crawford |
| Beneficiary | Karen Crawford (Mother) |
| Date of Death | February 15, 2026 |
| Cause of Death | Suicide (intentional self-harm) |
| Claim Amount | $40,000 |
| Documents | Death certificate, policy document |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Karen Crawford listed as primary beneficiary (mother) — matches policy
- Expected output: `confidence_score: 0.85+`, clean authentication

**Step 2 — Extractor Agent**
- Death certificate: manner of death is Suicide, investigated by LA County Medical Examiner
- Autopsy performed, toxicology shows prescribed antidepressants
- Policy document: effective December 2025, only 198 days old at time of death
- Extracts suicide clause: "limited to refund of premiums paid" within 2 years
- Expected output: flags suicide clause and contestability prominently

**Step 3 — Policy Verification Agent**
- Policy is active and in force
- BUT: within 2-year contestability period (198 days)
- Suicide clause applies: liability limited to premium refund ($1,015)
- Additional issue: Major Depressive Disorder not disclosed on application — material misrepresentation
- Expected output: `policy_active: true`, `exclusions_apply: [suicide_clause, material_misrepresentation]`

**Step 4 — Fraud Detection Agent**
- Not fraud per se, but policy exclusion applies
- Undisclosed mental health history is a material misrepresentation concern
- Expected output: `fraud_risk_score: 0.40–0.50`, flags misrepresentation

**Step 5 — Adjudication Agent**
- Auto-deny triggered: excluded cause of death (suicide within contestability)
- Per policy Section 4.2: maximum liability is premium refund of $1,015.00
- Additional grounds: material misrepresentation (undisclosed MDD)
- Expected output: `decision: deny`, `reasoning: Suicide within 2-year contestability period. Per policy Section 4.2, liability limited to premium refund of $1,015.00. Additionally, material misrepresentation on application (undisclosed Major Depressive Disorder).`

### How to Verify
1. Login as `adjuster1` → CLM-DEMO-006 → Denied with detailed exclusion reasoning
2. The AI should cite the specific policy section (4.2) and the contestability period
3. Should note that a premium refund of $1,015 may be owed even though the full claim is denied
4. This demonstrates the system's understanding of complex policy exclusions and contestability rules

---

## Scenario 7: Manual Review (Moderate Fraud Score)

**Claim ID**: CLM-DEMO-007
**Expected Outcome**: Escalated to human adjuster for review

### Claim Details
| Field | Value |
|-------|-------|
| Policy Number | LIP-2023-065478 |
| Policy Holder | William Henry Foster |
| Beneficiary | Linda Foster (50%) / Mark Foster (50%) |
| Date of Death | February 27, 2026 |
| Cause of Death | Pneumonia complications from COPD |
| Claim Amount | $28,000 |
| Documents | Death certificate, policy document |

### What Each Agent Does

**Step 1 — Authenticator Agent**
- Linda Foster (spouse) and Mark Foster (son) are listed beneficiaries
- Beneficiary split was changed 3 months before death (from 100% Linda to 50/50)
- Expected output: `confidence_score: 0.75–0.85`, notes recent beneficiary change

**Step 2 — Extractor Agent**
- Death certificate: pneumonia, COPD, CHF — natural causes, certified by physician
- Policy document: active since January 2023, premiums current
- Extracts critical detail: COPD diagnosed October 2022 and CHF diagnosed November 2022 — both BEFORE the policy application in December 2022
- Expected output: flags pre-existing conditions not disclosed at application

**Step 3 — Policy Verification Agent**
- Policy active and in force since January 2023
- Premiums current
- Contestability period expired January 2025 — company cannot rescind
- However, undisclosed pre-existing conditions (COPD, CHF) are noted
- Expected output: `policy_active: true`, notes misrepresentation but contestability expired

**Step 4 — Fraud Detection Agent**
- Moderate risk indicators:
  - COPD and CHF diagnosed before application but not disclosed
  - Beneficiary changed 3 months before death
  - Cause of death directly related to undisclosed conditions
- Mitigating factors:
  - Contestability period has expired (cannot rescind)
  - Policy is 3+ years old
  - Claim amount is modest ($28K)
- Expected output: `fraud_risk_score: 0.55–0.65`, `risk_level: high`

**Step 5 — Adjudication Agent**
- Escalation triggered: fraud_score in 0.5–0.8 range
- AI recommendation: likely approve (contestability expired, cannot rescind) but needs human judgment
- The undisclosed conditions are concerning but legally the company's recourse is limited
- Expected output: `decision: human_review`, `reasoning: Moderate fraud indicators (undisclosed pre-existing conditions) but contestability period has expired. Recommend senior adjuster review.`

### How to Verify
1. Login as `adjuster1` → CLM-DEMO-007 → Pending Review
2. AI provides its analysis showing the tension: misrepresentation exists but contestability expired
3. Adjuster must make the judgment call — the AI presents the facts and recommendation
4. This demonstrates the nuanced cases where AI assists but doesn't replace human judgment

---

## Quick Reference: All Scenarios at a Glance

| Claim ID | Scenario | Amount | Date of Death | Key Trigger | Expected Outcome |
|----------|----------|--------|---------------|-------------|-----------------|
| CLM-DEMO-001 | Clean claim, natural death | $25,000 | Feb 10, 2026 | All criteria met | ✅ Auto-Approved |
| CLM-DEMO-002 | Lapsed policy | $30,000 | Feb 18, 2026 | Policy lapsed 6 months ago | ❌ Auto-Denied |
| CLM-DEMO-003 | Suspicious timing & fraud | $45,000 | Feb 22, 2026 | Policy 83 days old, 10x increase | ❌ Auto-Denied (Fraud) |
| CLM-DEMO-004 | High-value clean claim | $150,000 | Feb 8, 2026 | Amount ≥ $100K threshold | ⏸️ Manual Review |
| CLM-DEMO-005 | Incomplete submission | $35,000 | Feb 25, 2026 | Missing death cert & medical records | 📄 Pending Documents |
| CLM-DEMO-006 | Suicide within contestability | $40,000 | Feb 15, 2026 | Excluded cause + misrepresentation | ❌ Auto-Denied (Exclusion) |
| CLM-DEMO-007 | Undisclosed pre-existing | $28,000 | Feb 27, 2026 | Fraud score 0.5–0.8 | ⏸️ Manual Review |

---

## Verification Commands

### Check all claim statuses at once
```bash
aws dynamodb scan --table-name <ClaimsTable> \
  --projection-expression "claimId, #s, scenario" \
  --expression-attribute-names '{"#s":"status"}' \
  --output table
```

### Check a specific claim's full processing details
```bash
aws dynamodb get-item --table-name <ClaimsTable> \
  --key '{"claimId":{"S":"CLM-DEMO-001"}}' \
  --output json
```

### Check AgentCore Runtime logs
```bash
# List runtimes
aws cloudformation describe-stacks \
  --stack-name LifeInsuranceAgentStack \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" \
  --output table

# Check CloudWatch logs for a specific agent
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/bedrock-agentcore" \
  --output table
```

### Verify documents in S3
```bash
aws s3 ls s3://<DocumentsBucket>/claims/ --recursive
```

---

## Demo Walkthrough Script

For a live demo, follow this sequence to show the full range of capabilities:

### Setup
1. Open the frontend URL in a browser
2. Have three browser tabs ready (or use incognito for role switching)

### Part 1: Claimant Portal (login as `claimant1` / `Test123!Pass`)
1. **Note the AI Claims Assistant chatbot** — auto-opens after 1.5 seconds with empathetic greeting
2. **Try the chatbot** — ask "What documents do I need?" or click a suggestion chip
3. **Show the Demo Quick-Fill dropdown** — explain the 7 pre-configured scenarios
4. **Submit Scenario 1** (STP Auto-Approve) — select from dropdown, show auto-filled fields, submit
5. **Watch status change**: Submitted → Processing → Approved (typically 2-5 seconds)
6. **Click into claim details** — show the AI reasoning, document verification findings, and decision
7. **Submit Scenario 3** (Fraud) — show auto-denial with fraud indicators
8. **Submit Scenario 4** (High-Value) — show escalation to manual review

### Part 2: Adjuster Workbench (login as `adjuster1` / `Test123!Pass`)
1. **Show the Claims Queue** — escalated claims from scenarios 4, 5, 7 should appear with status badges
2. **Click on an escalated claim** — show full details: policy number, beneficiary, relationship, date/cause of death
3. **Highlight the AI Processing Flow sidebar** (right side) — show the 8-step multi-agent pipeline with completed/failed/pending status for each step, agent badges, and simulated MCP tool calls
4. **Highlight the AI Insights panel** — show Claude's reasoning, confidence score, fraud score, and document verification badges
5. **Approve or deny the claim** — show one-click action, claim removed from queue
6. **Note**: If a claim is still processing, the sidebar shows animated spinners and auto-updates every 3 seconds

### Part 3: Business Dashboard (login as `business1` / `Test123!Pass`)
1. **Show summary stats** — total claims, approved, denied, pending, escalated counts
2. **Show Processing Performance** — average processing time, STP rate
3. **Show AI Agent Activity** — invocation count, fraud detections
4. **Show Status Distribution bar** — color-coded proportional view
5. **Show Claims Overview table** — all claims with status badges and AI decision summaries

### Key Talking Points
- AI processes claims in seconds, not days
- Empathetic chatbot guides grieving claimants through the process (claimant-only, auto-opens)
- AI verifies uploaded documents (death certificates, medical records, IDs) as part of adjudication
- Adjuster sees full 8-step AI processing pipeline with real-time status visualization
- Fraud detection catches coordinated patterns (Scenario 3: recent policy + 10x increase + beneficiary change)
- Human-in-the-loop for high-value and ambiguous cases
- Full audit trail with AI reasoning for every decision
- Three role-based portals for different stakeholders

---

## Troubleshooting

**Claims stuck in "Processing" status**
- Check Lambda logs for errors:
  ```bash
  aws logs tail /aws/lambda/LifeInsuranceClaimsHandler --since 5m --region us-east-1
  ```
- Verify Bedrock model access is enabled for Claude Sonnet 4
- Check Lambda timeout is set to 15 minutes (AgentCore parallel pipeline needs time for specialist calls)
- The Lambda self-invokes asynchronously — check for both the sync and async invocation logs

**Claims stuck in "Submitted" status (never moves to Processing)**
- The async self-invoke may have failed. Check Lambda IAM role has `lambda:InvokeFunction` permission on itself
- Check the Lambda function name matches what's in the code (`os.environ['AWS_LAMBDA_FUNCTION_NAME']`)

**AI returns unexpected decisions**
- The `POLICY_DATABASE` dict in `claims_handler.py` contains all 7 scenario policy records
- If a policy number isn't found, the AI is told "NO RECORD FOUND" and will likely deny or escalate
- Check the AI prompt in the Lambda code — it includes strict decision rules

**Adjuster Workbench shows empty queue**
- Verify the filter includes `['escalated', 'submitted', 'processing']` statuses
- Check that claims actually have `escalated` status in DynamoDB (not just `denied`)
- The `getClaims` API returns ALL claims — filtering happens on the frontend

**Business Dashboard shows zeros**
- Verify the metrics Lambda is deployed with the latest code
- Check that the Lambda has `CLAIMS_TABLE` environment variable set correctly
- The metrics are computed from actual DynamoDB data — if no claims exist, all stats will be zero

**Agent returns empty or error response**
- Verify Bedrock model access is enabled (Claude Sonnet 4)
- Check the Lambda's IAM role has `bedrock:InvokeModel` permission
- Verify the model ID is correct: `us.anthropic.claude-sonnet-4-20250514-v1:0`

**Documents not uploading**
- Check the Documents Lambda has the correct S3 bucket name in environment variables
- Verify CORS is configured on API Gateway for the documents endpoint

---

**End of Demo Testing Guide**

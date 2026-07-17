# CCOE Insurance Industry LLC — Architecture Deep Dive

A detailed walkthrough of every component in the system, how they connect, and the exact logic behind every claim outcome.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Infrastructure Layer](#infrastructure-layer)
3. [Frontend Application](#frontend-application)
4. [API Layer](#api-layer)
5. [Claims Processing Engine](#claims-processing-engine)
6. [AI Decision Logic](#ai-decision-logic)
7. [Document Verification](#document-verification)
8. [Business Dashboard & Metrics](#business-dashboard--metrics)
9. [AI Claims Assistant Chatbot](#ai-claims-assistant-chatbot)
10. [AgentCore Architecture (Target Design)](#agentcore-architecture)
11. [Scenario-by-Scenario Outcome Logic](#scenario-by-scenario-outcome-logic)
12. [Cost Model](#cost-model)

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Frontend (React 18 + Tailwind CSS)               │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐     │
│  │  Claimant    │  │  Adjuster        │  │  Business          │     │
│  │  Portal      │  │  Workbench       │  │  Dashboard         │     │
│  │  + Chatbot   │  │  + AI Flow Panel │  │  + Cost Analytics  │     │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬───────────┘     │
└─────────┼──────────────────┼──────────────────────┼──────────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│         CloudFront (HTTPS CDN) + API Gateway (Cognito Auth)          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Claims Lambda   │ │ Documents Lambda │ │  Metrics Lambda  │
│  CRUD + Events   │ │ S3 Upload/List   │ │  Analytics       │
│  15min / 256MB   │ │ 30s / 128MB      │ │  30s / 128MB     │
└────────┬─────────┘ └──────────────────┘ └──────────────────┘
         │                                         ┌──────────────────┐
         │  EventBridge: ClaimSubmitted /           │  Chat Lambda     │
         ▼  ClaimResubmitted                       │  FAQ Chatbot     │
┌──────────────────────────────────────────────────┐│  30s / 128MB     │
│  AI Claims Processing (dual path)                │└──────────────────┘
│                                                  │
│  PRIMARY: AgentCore Supervisor ──────────────────┤
│  ┌────────────────────────────────────────────┐  │
│  │  Bedrock AgentCore                         │  │
│  │  6 ECR-based ARM64 Runtimes                │  │
│  │  Built via CodeBuild, pushed to ECR        │  │
│  │  Consumption-based: $0.000763/session       │  │
│  │                                            │  │
│  │  Supervisor orchestrates 4-phase parallel   │  │
│  │  pipeline using ThreadPoolExecutor:         │  │
│  │  Phase 1: Authenticate ∥ Extract           │  │
│  │  Phase 2: PolicyVerify ∥ FraudDetect       │  │
│  │  Phase 3: Adjudicate (sequential)          │  │
│  │  Phase 4: Synthesize (single LLM call)     │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  FALLBACK: Bedrock InvokeModel ──────────────────┤
│  Claude Sonnet 4                                 │
│  us.anthropic.claude-sonnet-4-20250514-v1:0      │
│  max_tokens: 2048, temp: 0.1                     │
│  (used if AgentCore unavailable / cold start)    │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DynamoDB          │  S3 (3 buckets)    │  Cognito           │
│  LifeInsurance-    │  docs / frontend   │  3 groups:         │
│  Claims table      │  / knowledge-bases │  Claimants,        │
│  claimId + ts      │                    │  Adjusters,        │
│  (composite key)   │                    │  BusinessUsers     │
└──────────────────────────────────────────────────────────────────────┘
```

**Event-Driven Processing**: The Claims Lambda emits lifecycle events (`ClaimSubmitted`, `ClaimResubmitted`) to Amazon EventBridge. EventBridge rules route these to the ProcessClaim Lambda which performs a deterministic document completeness check (S3 scan), then invokes the AgentCore Supervisor to orchestrate 6 specialist agents in a 4-phase parallel pipeline. If AgentCore is unavailable, it falls back to direct Bedrock InvokeModel with the same decision logic.

**AgentCore Parallel Pipeline**: The Supervisor agent uses explicit 4-phase parallel orchestration (not sequential Strands SDK agent reasoning) via `concurrent.futures.ThreadPoolExecutor`:
- Phase 1 (parallel): Authenticate + Extract Documents
- Phase 2 (parallel): Policy Verification + Fraud Detection
- Phase 3 (sequential): Adjudication (needs all Phase 1+2 results)
- Phase 4 (sequential): Synthesize final JSON decision (single Bedrock LLM call)

The system is deployed across 3 consolidated CDK stacks in `us-east-1`:

| Stack | What It Creates |
|-------|----------------|
| `LifeInsuranceInfraStack` | S3 buckets, DynamoDB, Cognito, CloudFront, OpenSearch Serverless, 3 Bedrock Knowledge Bases, Bedrock Guardrail |
| `LifeInsuranceAgentStack` | 6 ECR repositories, CodeBuild project (ARM64), 6 AgentCore Runtimes (ECR-based) |
| `LifeInsuranceApiStack` | API Gateway, 5 Lambda functions, EventBridge event bus + rules, CloudWatch monitoring |

---

## 2. Infrastructure Layer

### DynamoDB — Claims Table (`LifeInsuranceClaims`)

Composite key design:
- Partition key: `claimId` (String) — e.g., `CLM-20260306-a1b2c3`
- Sort key: `timestamp` (Number) — epoch milliseconds at creation

Every read/update operation must first `query()` by `claimId` to retrieve both keys before calling `update_item()`. Direct `get_item()` with only the partition key silently returns nothing.

Key fields stored per claim:

| Field | Type | Description |
|-------|------|-------------|
| `claimId` | String | Unique ID (CLM-YYYYMMDD-random) |
| `timestamp` | Number | Creation epoch ms |
| `status` | String | submitted / processing / approved / denied / escalated |
| `policyNumber` | String | Links to POLICY_DATABASE lookup |
| `policyHolderName` | String | Deceased's name |
| `beneficiaryName` | String | Claimant's name |
| `relationship` | String | Relationship to deceased |
| `dateOfDeath` | String | Date of death |
| `causeOfDeath` | String | Cause of death |
| `claimAmount` | Number | Requested payout |
| `aiInsights` | String | AI reasoning text (human-readable) |
| `processingDetails` | String (JSON) | Full AI response: decision, confidence, fraud_score, document_findings, processing_steps |
| `adjusterNotes` | String | Notes from human adjuster (if acted upon) |
| `submittedAt` | Number | Epoch ms when submitted |
| `updatedAt` | Number | Epoch ms when last updated |
| `userId` | String | Cognito user ID of submitter |

### S3 Buckets

| Bucket | Purpose |
|--------|---------|
| `life-insurance-docs-<ACCOUNT_ID>-<REGION>` | Uploaded claim documents at `claims/{claimId}/{filename}` |
| `life-insurance-frontend-<ACCOUNT_ID>-<REGION>` | Built React app (private, served via CloudFront) |
| `life-insurance-kb-<ACCOUNT_ID>-<REGION>` | Knowledge Base source documents (policy guidelines, fraud patterns, regulatory) |

### CloudFront Distribution

- Origin: private S3 frontend bucket via Origin Access Identity (OAI)
- HTTPS only, default root object: `index.html`
- Custom error response: 403/404 → `/index.html` (SPA routing)
- Why CloudFront instead of public S3: account-level S3 Block Public Access is enabled

### Cognito User Pool

- Email alias enabled (but usernames must be plain text, not email format)
- 3 groups: `Claimants`, `Adjusters`, `BusinessUsers`
- Test users: `claimant1`, `adjuster1`, `business1` (password: `Test123!Pass`)
- Frontend uses AWS Amplify for token management (ID, Access, Refresh)
- API Gateway uses Cognito authorizer to validate JWT tokens

### OpenSearch Serverless

- Collection: `life-insurance-kb` (VECTORSEARCH type)
- 3 vector indices: `policy-guidelines-index`, `fraud-patterns-index`, `regulatory-index`
- Dimension: 1024 (Titan Embeddings), HNSW engine (faiss)
- Used by 3 Bedrock Knowledge Bases for RAG retrieval

### Bedrock Knowledge Bases

| KB | ID | Source Data |
|----|----|-------------|
| Policy Guidelines | *(auto-generated by CDK)* | Coverage rules, exclusions, contestability, suicide clause |
| Fraud Patterns | *(auto-generated by CDK)* | STOLI schemes, staged accidents, document fraud, historical cases |
| Regulatory | *(auto-generated by CDK)* | HIPAA, SOX, fair claims handling, state regulations |

### Bedrock Guardrail

- Guardrail ID: *(auto-generated by CDK)*
- Content filtering for harmful content
- PII anonymization (names, SSNs, addresses)
- Applied to AgentCore runtimes

---

## 3. Frontend Application

Built with React 18 + TypeScript + Vite + Tailwind CSS. Deployed to CloudFront.

### Routing & Access Control

`App.tsx` defines routes with `RoleGuard` component that checks the user's Cognito group:

| Route | Component | Required Group |
|-------|-----------|---------------|
| `/login` | Login | (public) |
| `/portal/*` | ClaimantPortal | Claimants |
| `/adjuster` | AdjusterWorkbench | Adjusters |
| `/dashboard` | BusinessDashboard | BusinessUsers |

The `ChatWidget` component renders only for users in the `Claimants` group. It auto-opens after 1.5 seconds with an empathetic greeting.

### Claimant Portal

**SubmitClaim.tsx**: Form with Demo Quick-Fill dropdown (7 scenarios). On submit:
1. POST `/claims` with form data → receives `claimId`
2. POST `/claims/{claimId}/documents` for each uploaded file (parallel)
3. Redirects to MyClaims list

**MyClaims.tsx**: Lists all claims for the logged-in user with status badges.

**ClaimDetails.tsx**: Shows full claim data, AI reasoning (`aiInsights`), document verification findings, and processing steps parsed from `processingDetails` JSON.

### Adjuster Workbench

**AdjusterWorkbench.tsx**: Two-panel layout:
- Left: claims queue filtered to `['escalated', 'submitted', 'processing']` statuses
- Right: selected claim details + AI Processing Flow sidebar

The AI Processing Flow sidebar shows 8 simulated steps:
1. Claim Received (System)
2. Document Verification (Extractor Agent)
3. Death Registry Lookup (Authenticator Agent) — `mcp:death_registry.verify_record`
4. Obituary & Public Records (Authenticator Agent) — `mcp:web_search.find_obituary`
5. Beneficiary Authentication (Authenticator Agent) — `mcp:identity_verification.validate`
6. Policy Verification (Policy Verification Agent) — `knowledge_base:policy-guidelines`
7. Fraud Analysis (Fraud Detection Agent) — `knowledge_base:fraud-patterns`
8. Adjudication Decision (Adjudication Agent) — `knowledge_base:regulatory`

Step statuses are derived from `processingDetails` JSON. Auto-polls every 3 seconds while claim is `submitted` or `processing`.

Approve/Deny buttons call `POST /claims/{id}/approve` or `/deny`.

### Business Dashboard

**BusinessDashboard.tsx**: Tabbed interface with 4 focused views:

- **Overview**: Executive KPIs (total claims, STP rate, avg processing time, fraud detected), status distribution donut chart, pipeline status bar, recent claims table
- **Operations**: Real-time view with 10s auto-refresh, processing pipeline visualization (Submitted → Processing → Decision), live claims feed
- **Analytics**: Decision distribution pie chart, claims by amount range bar chart, fraud score distribution, AI performance metrics
- **Cost & AI**: Manual vs AI cost comparison with savings %, complexity tier breakdown (Simple/Standard/Complex), token usage chart, cost breakdown, ROI metrics

---

## 4. API Layer

API Gateway REST API with Cognito authorizer. All endpoints require a valid JWT token.

| Method | Path | Lambda | Description |
|--------|------|--------|-------------|
| POST | `/claims` | Claims | Create claim, trigger async AI processing |
| GET | `/claims` | Claims | List all claims |
| GET | `/claims/{id}` | Claims | Get single claim (queries by claimId) |
| PUT | `/claims/{id}` | Claims | Update claim fields |
| POST | `/claims/{id}/approve` | Claims | Adjuster approves claim |
| POST | `/claims/{id}/deny` | Claims | Adjuster denies claim |
| POST | `/claims/{id}/resubmit` | Claims | Resubmit with additional docs |
| POST | `/claims/{id}/documents` | Documents | Upload file to S3 |
| GET | `/claims/{id}/documents` | Documents | List uploaded files |
| GET | `/metrics/dashboard` | Metrics | Full dashboard metrics |
| GET | `/metrics/breakdown` | Metrics | Claims breakdown by amount |
| POST | `/chat` | Chat | FAQ chatbot message |

All Lambda responses include CORS headers restricted to the CloudFront distribution domain and use `DecimalEncoder` for DynamoDB Decimal serialization.

---

## 5. Claims Processing Engine

This is the core of the system. Located in `backend/lambda/claims/claims_handler.py`.

### Synchronous Phase (< 1 second)

```
POST /claims → handler() → create_claim()
  1. Generate claimId: CLM-{YYYYMMDDHHMMSS}
  2. Input validation (field lengths, format checks, prompt injection detection)
  3. Write to DynamoDB: status='submitted', submittedAt=now
  4. Emit ClaimSubmitted event to Amazon EventBridge
  5. Return claimId to frontend immediately
```

Why EventBridge? API Gateway has a 29-second hard timeout. EventBridge decouples the API response from AI processing with built-in retries, DLQ support, and event lifecycle tracking.

### Asynchronous Phase (5-20 seconds)

```
_async_process_claim(event):
  1. Update status → 'processing'
  2. time.sleep(5)  # Wait for document uploads to complete
  3. Fetch documents from S3: _fetch_claim_documents(claimId)
  4. Look up policy from POLICY_DATABASE dict
  5. Call _process_claim_with_ai(claim)
  6. Parse AI JSON response
  7. Update DynamoDB: status, aiInsights, processingDetails, updatedAt
```

### POLICY_DATABASE

A Python dict in `claims_handler.py` containing policy records for all 9 demo scenarios. Each entry is keyed by policy number and includes:

```python
POLICY_DATABASE = {
    'LIP-2019-087234': {  # Scenario 1: Clean claim
        'status': 'ACTIVE',
        'holder': 'Robert James Mitchell',
        'face_amount': 250000,
        'premium_status': 'Current through March 2026',
        'effective_date': 'June 15, 2019',
        'beneficiary': 'Margaret Anne Mitchell (Spouse) - Primary 100%',
        'exclusions': 'Standard exclusions apply. Suicide clause expired.',
        'contestability': 'Expired (policy > 2 years)',
        'notes': 'Long-standing policy, no changes, no claims history'
    },
    # ... entries for all 9 scenarios
}
```

If a policy number is not found, the AI prompt says "NO POLICY RECORD FOUND IN DATABASE" and the AI will typically deny or escalate.

---

## 6. AI Decision Logic

### The Prompt

The AI prompt sent to Claude Sonnet 4 has this structure:

```
ROLE: You are an AI claims adjudicator for CCOE Insurance Industry LLC
      specializing in death benefits claims.

CLAIM DATA:
  - Policy Number, Holder, Beneficiary, Relationship
  - Date of Death, Cause of Death, Claim Amount

POLICY CONTEXT FROM DATABASE:
  - Full policy record (status, premiums, beneficiary, exclusions, contestability)

SUBMITTED DOCUMENTS:
  - Text content of each uploaded file (death certificates, medical records, IDs)

DECISION RULES:
  Auto-Approve (ALL must be true):
    - fraud_score < 0.3
    - Policy active with premiums current
    - No exclusions apply
    - All documents present and valid
    - Claim amount < $100,000

  Auto-Deny (ANY triggers):
    - Policy lapsed
    - Excluded cause of death (e.g., suicide within contestability)
    - fraud_score >= 0.7
    - Material misrepresentation during contestability

  Escalate to Human (ANY triggers):
    - Claim amount ≥ $100,000
    - fraud_score between 0.5 and 0.7
    - Missing critical documents
    - Beneficiary disputes

DOCUMENT VERIFICATION INSTRUCTIONS:
  - Cross-reference death certificate with claim data
  - Verify policy document matches claimed policy number
  - Check medical records against cause of death
  - Flag inconsistencies

OUTPUT FORMAT: Strict JSON with decision, confidence, reasoning,
  fraud_score, policy_valid, authentication_passed,
  documents_verified, document_findings, processing_steps
```

### Response Parsing

The Lambda parses the JSON response and maps:
- `"approved"` → DynamoDB status `approved`
- `"denied"` → DynamoDB status `denied`
- `"escalated"` or `"human_review"` → DynamoDB status `escalated`

If JSON parsing fails, the claim is escalated with an error note.

### Fraud Score Calculation

The AI assigns a fraud score (0.0 to 1.0) based on these indicators:

| Indicator | Impact |
|-----------|--------|
| Policy purchased < 6 months before death | +0.2–0.3 |
| Beneficiary changed recently | +0.1–0.2 |
| Large coverage increase before death | +0.2–0.3 |
| Accidental death with no autopsy | +0.1–0.2 |
| Conflicting information across documents | +0.1–0.2 |
| Undisclosed pre-existing conditions | +0.1–0.2 |
| Natural causes with documented history | -0.1–0.2 |
| Policy > 5 years old | -0.1 |
| Complete documentation | -0.05 |

---

## 7. Document Verification

`_fetch_claim_documents(claim_id)` in `claims_handler.py`:

1. Lists objects in S3 at `claims/{claimId}/`
2. Reads each file's text content (`.txt` files for demo)
3. Concatenates as `=== filename ===\n{content}` blocks
4. Passes to AI prompt under `SUBMITTED DOCUMENTS` section

The AI cross-references documents against claim data and reports:
- `documents_verified`: boolean — all docs consistent
- `document_findings`: text — specific findings per document

The 5-second delay before fetching ensures documents uploaded in parallel with the claim submission have time to land in S3.

---

## 8. Business Dashboard & Metrics

`backend/lambda/metrics/metrics_handler.py` scans the entire DynamoDB claims table and computes all metrics in real-time.

### Claim Complexity Classification

Each claim is classified into one of three tiers based on its outcome:

| Tier | Criteria | AI Cost/Claim |
|------|----------|---------------|
| Simple | Auto-approved or denied, fraud < 0.3, amount < $100K | ~$0.01 |
| Standard | Moderate analysis, fraud 0.3–0.5, not escalated | ~$0.02 |
| Complex | Escalated, amount ≥ $100K, or fraud ≥ 0.5 | ~$5.03 (incl. $5 adjuster) |

Classification logic in `_classify_claim_complexity()`:
```python
if status == 'escalated' or claim_amount >= 50000 or fraud_score >= 0.5:
    return 'complex'
elif status in ('approved', 'denied') and fraud_score < 0.3 and claim_amount < 50000:
    return 'simple'
else:
    return 'standard'
```

### Cost Model

Per-complexity cost profiles define the expected resource usage:

| Component | Simple | Standard | Complex |
|-----------|--------|----------|---------|
| Input tokens | 1,500 | 2,000 | 3,000 |
| Output tokens | 400 | 600 | 800 |
| Lambda duration | 8s | 12s | 18s |
| AgentCore sessions | 2 | 4 | 6 |
| Adjuster cost | $0 | $0 | $5.00 |

Cost rates:
- Bedrock: $0.003/1K input tokens, $0.015/1K output tokens (Claude Sonnet 4)
- Lambda: $0.0000002/invocation + $0.0000166667/GB-second × 0.25 GB
- AgentCore: $0.000763/session (consumption-based: CPU $0.0895/vCPU-hr, Memory $0.00945/GB-hr, I/O wait free)

### Metrics Returned

The `/metrics/dashboard` endpoint returns:

| Metric | How It's Computed |
|--------|-------------------|
| `totalClaims` | Count of all items in table |
| `approvedClaims` | Count where status = 'approved' |
| `deniedClaims` | Count where status = 'denied' |
| `escalatedClaims` | Count where status = 'escalated' |
| `pendingClaims` | Count where status = 'submitted' or 'processing' |
| `avgProcessingTime` | Mean of (updatedAt - submittedAt) for decided claims |
| `stpRate` | % of claims auto-decided by AI (have processingDetails, no adjusterNotes) |
| `agentInvocations` | Count of claims with processingDetails |
| `fraudDetected` | Count where fraud_score ≥ 0.7 |
| `costByComplexity` | Per-tier: count, percentage, cost per claim |
| `aiAutoHandledPct` | (simple + standard) / total × 100 |
| `totalAiCost` | Sum of AI infrastructure costs (excludes adjuster cost) |
| `agentcorePerClaim` | Avg AgentCore cost per claim (~4 sessions × $0.000763) |
| `agentcoreMonthlyEst` | Projected monthly at 1K claims/month |
| `claimLeakage` | Approved amount / total claimed amount × 100 |
| `escalatedCycleTime` | Mean cycle time for escalated claims |
| `touchesPerClaim` | Avg interactions: submission + AI + escalation + adjuster |
| `totalTokens` | Sum of input + output tokens from processingDetails |
| `bedrockCost` | Actual token charges from real usage |
| `agentcoreTotalCost` | Actual AgentCore charges from real claims |
| `lambdaTotalCost` | Actual Lambda charges from real claims |

---

## 9. AI Claims Assistant Chatbot

`backend/lambda/chat/chat_handler.py` — a separate Lambda calling Claude Sonnet 4.

| Parameter | Value |
|-----------|-------|
| Model | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| Max tokens | 512 |
| Temperature | 0.3 |
| Conversation history | Last 6 messages |

The system prompt instructs Claude to:
- Be warm, empathetic, and concise (< 150 words per response)
- Answer questions about required documents, claim process steps, timelines
- Redirect legal, tax, and financial questions to professionals
- Stay within claims-related topics only

The frontend `ChatWidget` component:
- Only renders for Claimant role (checked via Cognito group in App.tsx)
- Auto-opens after 1.5 seconds with empathetic greeting
- Shows suggestion chips on first interaction ("What documents do I need?", etc.)
- Sends conversation history with each request for context continuity

---

## 10. AgentCore Architecture (ECR-Based)

Six specialist agents are deployed on Bedrock AgentCore as ECR-based ARM64 containers:

| Agent | ECR Repository | Role |
|-------|---------------|------|
| Supervisor | `life-insurance/supervisor` | Orchestrates the 4-phase parallel claims pipeline |
| Authenticator | `life-insurance/authenticator` | Validates beneficiary identity |
| Extractor | `life-insurance/extractor` | Document data extraction |
| Policy Verification | `life-insurance/policy_verification` | Policy status and coverage checks (RAG) |
| Fraud Detection | `life-insurance/fraud_detection` | Fraud indicator analysis (RAG) |
| Adjudication | `life-insurance/adjudication` | Final decision making (RAG) |

**How ECR Deployment Works**:
1. CDK uploads all agent source directories to S3 as a single asset (zip)
2. CodeBuild project (ARM64 `AMAZON_LINUX_2_STANDARD_3_0` environment) downloads the source
3. Builds Docker images for each agent using `FROM --platform=linux/arm64 python:3.11-slim`
4. Images are pushed to their respective ECR repositories
5. Custom resource Lambda triggers CodeBuild and polls for completion
6. AgentCore runtimes reference ECR image URIs via `ContainerConfiguration`
7. Deploy timestamp in runtime Description forces container re-pull on each `cdk deploy`

**Why ECR instead of Direct Code Deploy**: The initial approach used Direct Code Deploy (S3-based), but AgentCore cold starts exceeded 30 seconds due to `pip install` of `strands-agents` dependencies at boot time. ECR-based deployment bakes all dependencies into the Docker image, eliminating boot-time installation. AgentCore requires ARM64 (Graviton) images.

**Supervisor Parallel Pipeline Architecture**:

The Supervisor agent uses explicit Python orchestration with `concurrent.futures.ThreadPoolExecutor` instead of Strands SDK agent reasoning. This eliminates LLM reasoning overhead between tool calls and prevents duplicate specialist invocations.

```
┌─────────────────────────────────────────────────────────────────┐
│  Supervisor Agent (invoke entrypoint)                           │
│                                                                 │
│  1. Enrich: lookup_policy() + fetch_claim_documents()           │
│                                                                 │
│  2. Phase 1 (parallel, ThreadPoolExecutor):                     │
│     ┌──────────────────┐  ┌──────────────────┐                  │
│     │  Authenticator   │  │  Extractor        │                 │
│     │  (identity)      │  │  (documents)      │                 │
│     └────────┬─────────┘  └────────┬──────────┘                 │
│              └──────────┬──────────┘                             │
│                         ▼                                       │
│  3. Phase 2 (parallel, ThreadPoolExecutor):                     │
│     ┌──────────────────┐  ┌──────────────────┐                  │
│     │  Policy          │  │  Fraud            │                 │
│     │  Verification    │  │  Detection        │                 │
│     └────────┬─────────┘  └────────┬──────────┘                 │
│              └──────────┬──────────┘                             │
│                         ▼                                       │
│  4. Phase 3 (sequential):                                       │
│     ┌──────────────────────────────────────────┐                │
│     │  Adjudication (all Phase 1+2 results)    │                │
│     └────────────────────┬─────────────────────┘                │
│                          ▼                                      │
│  5. Phase 4 (sequential):                                       │
│     ┌──────────────────────────────────────────┐                │
│     │  _synthesize_decision()                  │                │
│     │  Single Bedrock LLM call → final JSON    │                │
│     └──────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

Key functions in `supervisor.py`:
- `_call_specialist_raw(agent_arn, prompt)` — calls a specialist AgentCore runtime and returns raw response text
- `_synthesize_decision(...)` — single Bedrock InvokeModel call (Claude Sonnet 4, temp 0.1) to produce the final structured JSON from all specialist outputs
- `create_supervisor()` — Strands agent kept only as fallback for non-claim prompts

**Decision Rules** (enforced in synthesis prompt, applied in order):
1. LAPSED policy → DENY
2. Suicide within 2-year contestability → DENY
3. Fraud score >= 0.7 with multiple red flags → DENY
4. Missing critical documents → ESCALATE
5. Fraud score 0.5-0.7 → ESCALATE
6. Claim amount >= $100,000 → ESCALATE
7. Policy ACTIVE + premiums current + contestability expired + fraud < 0.3 + amount < $100K + docs present → APPROVE
8. Otherwise → ESCALATE

**Claims Lambda integration**: The Claims Lambda tries AgentCore Supervisor first via `_invoke_agentcore_supervisor()`. If that fails, it falls back to `_process_claim_with_bedrock()` which calls Bedrock InvokeModel directly. The `processing_path` field in the result tracks which path was used.

---

## 11. Scenario-by-Scenario Outcome Logic

### Scenario 1: Clean Claim — Auto-Approved

| Field | Value |
|-------|-------|
| Policy | LIP-2019-087234 (Active since 2019, 7 years) |
| Amount | $25,000 (< $100K threshold) |
| Cause | Heart attack (natural, no exclusions) |
| Beneficiary | Margaret Mitchell (spouse, matches policy) |

**Why approved**: Policy active ✓, premiums current ✓, contestability expired ✓, no exclusions ✓, fraud score ~0.05-0.15 (< 0.3) ✓, amount < $100K ✓, all documents present ✓. Every auto-approve criterion is met.

### Scenario 2: Lapsed Policy — Auto-Denied

| Field | Value |
|-------|-------|
| Policy | LIP-2018-054891 (LAPSED since Sept 2025) |
| Amount | $30,000 |
| Cause | Stroke |
| Beneficiary | Jennifer Parker (ex-spouse, outdated designation) |

**Why denied**: Policy lapsed September 1, 2025 — 6 months before death. Last premium paid July 2025, grace period ended August 2025. Three notices sent. No coverage in force at time of death. Auto-deny triggered by lapsed policy rule. The outdated beneficiary designation (ex-spouse) is noted but the lapse alone is sufficient for denial.

### Scenario 3: Fraud Indicators — Auto-Denied

| Field | Value |
|-------|-------|
| Policy | LIP-2025-112847 (83 days old) |
| Amount | $45,000 |
| Cause | Drowning, BAC 0.18, no autopsy |
| Beneficiary | Maria Elena Reyes (spouse, added 45 days before death) |

**Why denied**: Multiple coordinated fraud indicators push fraud score to 0.85-0.95:
- Policy only 83 days old (purchased shortly before death)
- Coverage increased 10x from $50K to $500K (previous policy cancelled and replaced)
- Beneficiary changed from brother to spouse 45 days before death
- Accidental drowning with high blood alcohol, family declined autopsy
- Within 2-year contestability period

Fraud score > 0.8 triggers auto-deny. AI recommends SIU (Special Investigations Unit) investigation.

### Scenario 4: High-Value Claim — Escalated

| Field | Value |
|-------|-------|
| Policy | LIP-2015-023456 (Active since 2015, 11 years) |
| Amount | $150,000 (≥ $100K threshold) |
| Cause | Pancreatic cancer (natural) |
| Beneficiary | Thornton Family Trust (60%) + Catherine Thornton-Wells (40%) |

**Why escalated**: Everything checks out — policy active 11 years, premiums current, no fraud indicators (score ~0.05-0.10), natural cause, no exclusions. But the claim amount of $150,000 exceeds the $100,000 auto-approve threshold. Per company policy, high-value claims require senior adjuster sign-off regardless of AI assessment. AI recommends approval but escalates for human confirmation.

### Scenario 5: Missing Documents — Escalated

| Field | Value |
|-------|-------|
| Policy | LIP-2021-078345 (Active) |
| Amount | $35,000 |
| Cause | Heart attack (per claimant, unverified) |
| Documents | Claim form only — no death certificate, no medical records |

**Why escalated**: Cannot auto-approve without critical documents. The AI cannot verify cause of death, cross-reference medical history, or confirm the death occurred. Missing documents rule triggers escalation. Fraud score elevated to ~0.30-0.40 due to uncertainty (not fraud, but incomplete information). System requests: death certificate, medical records, beneficiary ID.

### Scenario 6: Suicide Exclusion — Auto-Denied

| Field | Value |
|-------|-------|
| Policy | LIP-2025-098712 (198 days old, within contestability) |
| Amount | $40,000 |
| Cause | Suicide (intentional self-harm) |
| Beneficiary | Karen Crawford (mother) |

**Why denied**: Two independent denial grounds:
1. Suicide within 2-year contestability period — policy Section 4.2 limits liability to premium refund ($1,015.00)
2. Material misrepresentation — Major Depressive Disorder diagnosed before application but not disclosed

The AI cites the specific policy section and notes that a premium refund of $1,015 may be owed even though the full $40,000 claim is denied. Auto-deny triggered by excluded cause of death.

### Scenario 7: Undisclosed Pre-existing — Escalated

| Field | Value |
|-------|-------|
| Policy | LIP-2023-065478 (Active since Jan 2023, 3+ years) |
| Amount | $28,000 |
| Cause | Pneumonia from COPD |
| Beneficiary | Linda Foster (50%) + Mark Foster (50%) |

**Why escalated**: This is the nuanced case. The AI detects:
- COPD diagnosed Oct 2022 and CHF diagnosed Nov 2022 — both BEFORE the policy application in Dec 2022
- Cause of death directly related to undisclosed conditions
- Beneficiary split changed 3 months before death (from 100% Linda to 50/50)
- Fraud score ~0.55-0.65 (moderate range)

However, the contestability period expired January 2025 — the company legally cannot rescind the policy. The AI recognizes this tension: misrepresentation exists but the company's recourse is limited. Escalated for human judgment. AI recommends likely approval given expired contestability.

---

## 12. Cost Model

### Per-Claim AI Infrastructure Cost (excludes human adjuster)

| Tier | Bedrock Tokens | Lambda | AgentCore | Total AI Cost |
|------|---------------|--------|-----------|---------------|
| Simple | $0.0105 | $0.0000 | $0.0015 | ~$0.012 |
| Standard | $0.0150 | $0.0001 | $0.0031 | ~$0.018 |
| Complex | $0.0210 | $0.0001 | $0.0046 | ~$0.025 |

Complex claims add $5.00 estimated adjuster time, bringing total to ~$5.03.

### Production Scale Estimates (1,000 claims/month)

Assuming 70% simple, 20% standard, 10% complex:
- AI infrastructure: ~$15/month
- Adjuster time (complex only): ~$500/month
- AgentCore monthly: ~$3.05 (consumption-based, no idle costs)
- Total Bedrock tokens: ~1.7M tokens/month (~$12)

### AWS Service Costs (Monthly)

| Service | Cost | Notes |
|---------|------|-------|
| OpenSearch Serverless | $100–200 | Fixed OCU-based pricing |
| Bedrock API | $30–50 | Token-based, scales with volume |
| Lambda | $10–20 | Pay per invocation |
| DynamoDB | $5–10 | On-demand capacity |
| S3 + CloudFront | $5–10 | Storage + CDN |
| Other (API GW, CloudWatch) | $10–20 | Requests + logs |
| **Total** | **$160–305** | Development/demo workload |

---

**End of Architecture Deep Dive**

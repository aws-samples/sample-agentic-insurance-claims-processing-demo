# CCOE Insurance Industry LLC — System Architecture

## Overview

AI-powered death benefits claims processing system built on AWS serverless architecture with event-driven processing via Amazon EventBridge. Claims are processed through a deterministic document completeness check, then adjudicated by 6 specialist agents on Bedrock AgentCore in a 4-phase parallel pipeline. Direct Bedrock InvokeModel serves as a fallback if AgentCore is unavailable.

**Claim Type**: Death Benefits Only (for demo purposes)

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Frontend (React + Tailwind CSS)              │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  Claimant    │  │  Adjuster        │  │  Business        │   │
│  │  Portal      │  │  Workbench       │  │  Dashboard       │   │
│  │  + Chatbot   │  │  + AI Flow Panel │  │  + Cost Analytics │   │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘   │
└─────────┼──────────────────┼──────────────────────┼──────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│              CloudFront CDN + API Gateway (Cognito Auth)         │
└──────────────────────────────┬───────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Claims Lambda   │ │ Documents Lambda │ │  Metrics Lambda  │ │   Chat Lambda    │
│  (CRUD + Events) │ │  (Upload/List)   │ │  (Analytics)     │ │  (FAQ Chatbot)   │
└────────┬─────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
         │
         │  ClaimSubmitted / ClaimResubmitted events
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Amazon EventBridge (claims-processing-bus)                      │
│  Routes claim lifecycle events to processing targets             │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  ProcessClaim Lambda                                             │
│  1. Deterministic document completeness check (S3)               │
│  2. If docs missing → ESCALATE immediately (no AI call)          │
│  3. If docs present → AgentCore Supervisor (6-agent pipeline)    │
│     (us.anthropic.claude-sonnet-4-20250514-v1:0)                 │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  DynamoDB (Claims)  │  S3 (Documents)  │  Cognito (Auth)        │
└──────────────────────────────────────────────────────────────────┘

─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  TARGET ARCHITECTURE: AgentCore Supervisor Runtime
  ┌─────────────────────────────────────────────────────────┐
  │  Bedrock AgentCore — 6 ECR-based ARM64 Runtimes         │
  │  Built via CodeBuild, pushed to ECR                     │
  │  Consumption-based: $0.000763/session                   │
  │                                                         │
  │  Supervisor: 4-phase parallel pipeline                  │
  │  Phase 1: Authenticate ∥ Extract                       │
  │  Phase 2: PolicyVerify ∥ FraudDetect                   │
  │  Phase 3: Adjudicate → Phase 4: Synthesize             │
  └─────────────────────────────────────────────────────────┘
```

**Processing Path**: Claims Lambda emits events to EventBridge. The ProcessClaim Lambda performs a deterministic document check, then invokes the AgentCore Supervisor which orchestrates 6 specialist agents in a 4-phase parallel pipeline. If AgentCore is unavailable, it falls back to direct Bedrock InvokeModel. The `processing_path` field in the AI result indicates which path was used (`agentcore` or `bedrock_direct`).

---

## CDK Stack Architecture

The system is deployed across 3 consolidated CDK stacks in `us-east-1`:

| Stack | What It Creates |
|-------|----------------|
| `LifeInsuranceInfraStack` | S3 buckets, DynamoDB, Cognito, CloudFront, OpenSearch Serverless, 3 Bedrock Knowledge Bases, Bedrock Guardrail |
| `LifeInsuranceAgentStack` | 6 ECR repositories, CodeBuild project (ARM64), 6 AgentCore Runtimes |
| `LifeInsuranceApiStack` | API Gateway, 5 Lambda functions, Amazon EventBridge event bus, CloudWatch monitoring, API GW CloudWatch role |

---

## AWS Services Used

### Core Services
| Service | Purpose |
|---------|---------|
| Amazon Bedrock | AI claim adjudication and chatbot (model configurable via `scripts/select_model.py`) |
| Amazon Bedrock AgentCore | 6 agent runtimes (ECR-based ARM64 containers) |
| Amazon ECR | 6 container image repositories (one per agent) |
| AWS CodeBuild | Builds ARM64 Docker images in-cloud (no local Docker needed) |
| Bedrock Knowledge Bases | RAG for policies, fraud patterns, regulations |
| Bedrock Guardrails | Content filtering, PII anonymization |
| Amazon EventBridge | Event-driven claim processing and lifecycle events |
| AWS Lambda | 5 API handlers (claims, process-claim, documents, metrics, chat) |
| Amazon DynamoDB | Claims data (composite key: claimId + timestamp) |
| Amazon S3 | Document storage, frontend assets, knowledge base data |
| Amazon CloudFront | CDN for frontend (private S3 bucket with OAI) |
| Amazon OpenSearch Serverless | Vector database for Knowledge Base RAG |
| Amazon Cognito | Authentication (3 groups: Claimants, Adjusters, BusinessUsers) |
| Amazon API Gateway | REST API with Cognito authorizer |
| AWS CDK | Infrastructure as Code (TypeScript, 3 consolidated stacks) |

### Supporting Services
| Service | Purpose |
|---------|---------|
| AWS IAM | Role-based access control |
| Amazon CloudWatch | Logging, monitoring, dashboards, alarms |
| AWS CloudFormation | Stack management (via CDK) |
| AWS KMS | Encryption (S3 uses SSE-S3 for demo) |

---

## AgentCore Architecture (ECR-Based)

Six specialist agents are deployed on Bedrock AgentCore as ECR-based ARM64 containers:

| Agent | ECR Repository | Role |
|-------|---------------|------|
| Supervisor | `life-insurance/supervisor` | Orchestrates the 4-phase parallel claims pipeline |
| Authenticator | `life-insurance/authenticator` | Validates beneficiary identity and claim authenticity |
| Extractor | `life-insurance/extractor` | Document data extraction |
| Policy Verification | `life-insurance/policy_verification` | Checks policy status, coverage, exclusions (RAG) |
| Fraud Detection | `life-insurance/fraud_detection` | Analyzes fraud indicators and risk patterns (RAG) |
| Adjudication | `life-insurance/adjudication` | Makes approval/denial decisions (RAG) |

### Supervisor Parallel Pipeline

The Supervisor agent uses explicit Python orchestration with `concurrent.futures.ThreadPoolExecutor` instead of sequential Strands SDK agent reasoning:

```
Phase 1 (parallel):  Authenticate + Extract Documents     (~26s)
Phase 2 (parallel):  Verify Policy + Detect Fraud         (~18s)
Phase 3 (sequential): Adjudicate (needs all Phase 1+2)    (~28s)
Phase 4 (sequential): Synthesize final JSON (single LLM)  (~5s)
                                              Total: ~74s estimated
```

This replaced the original sequential Strands agent orchestration (~214s) with a 65% reduction in processing time. The Strands agent is kept only as a fallback for non-claim prompts.

### How ECR Deployment Works

1. CDK uploads all agent source directories to S3 as a single asset (zip)
2. CodeBuild project (ARM64 environment) downloads the source, builds Docker images for each agent
3. Images are pushed to their respective ECR repositories
4. Custom resource Lambda triggers CodeBuild and polls for completion
5. AgentCore runtimes reference ECR image URIs (`ContainerConfiguration`)
6. All images use `FROM --platform=linux/arm64 python:3.11-slim` base

### Why ECR Instead of Direct Code Deploy

The initial approach used Direct Code Deploy (S3-based), but AgentCore cold starts exceeded 30 seconds due to `pip install` of `strands-agents` dependencies at boot time. ECR-based deployment bakes all dependencies into the Docker image, eliminating boot-time installation.

---

## Claim Processing Flow

### Synchronous Phase (API Gateway → Claims Lambda)
1. Claimant submits claim via portal (or uses Demo Quick-Fill dropdown)
2. Claims Lambda creates record in DynamoDB with status `submitted`
3. Claims Lambda emits a `ClaimSubmitted` event to Amazon EventBridge
4. Returns claim ID to frontend immediately

### Asynchronous Phase (EventBridge → ProcessClaim Lambda)
1. EventBridge rule triggers `ProcessClaimHandler` Lambda
2. Handler updates status to `processing`
3. **Deterministic document completeness check** (S3): verifies presence of `death_certificate`, `medical_records`, `beneficiary_id`
   - If any document is missing → immediately sets status to `ESCALATE` (no AI call made)
4. If all documents present → invokes AgentCore Supervisor (6-agent pipeline); falls back to Bedrock InvokeModel if unavailable
5. Looks up policy from `POLICY_DATABASE` dict (9 demo scenarios)
6. AI returns structured JSON: decision, confidence, reasoning, fraud_score, document findings
7. DynamoDB updated with decision, AI insights, and `processing_path`

### Resubmission Flow
1. Claimant uploads missing documents via portal
2. Claimant resubmits the claim
3. Claims Lambda emits a `ClaimResubmitted` event to EventBridge
4. Same `ProcessClaimHandler` Lambda re-evaluates the claim (deterministic check → AI if docs complete)

### Decision Rules (enforced in AI prompt, applied in order)
1. LAPSED policy → DENY
2. Suicide within 2-year contestability → DENY
3. Fraud score >= 0.7 → DENY
4. Missing critical documents → ESCALATE
5. Fraud score 0.5–0.7 → ESCALATE
6. Claim amount ≥ $100,000 → ESCALATE
7. Policy active + premiums current + contestability expired + fraud < 0.3 + amount < $100K + docs present → APPROVE
8. Otherwise → ESCALATE

---

## Frontend Architecture

### Three Role-Based Portals

**Claimant Portal** (`claimant1` / `Test123!Pass`)
- Submit claims with multi-file document upload
- Demo Quick-Fill dropdown (9 pre-configured scenarios)
- Track claim status in real-time
- View AI decision reasoning and document verification findings
- AI Claims Assistant chatbot (auto-opens after 1.5s, empathetic FAQ guidance)

**Adjuster Workbench** (`adjuster1` / `Test123!Pass`)
- Review queue with escalated/submitted/processing claims
- Full claim details with AI Insights panel
- AI Processing Flow sidebar — 8-step multi-agent pipeline visualization
- One-click approve/deny actions
- Auto-polls every 3 seconds while claims are processing

**Business Dashboard** (`business1` / `Test123!Pass`)
- Tabbed interface with 4 views: Overview (executive KPIs, status donut chart, claims table), Operations (real-time with 10s auto-refresh, live claims feed, pipeline visualization), Analytics (decision distribution, claims by amount, fraud breakdown), Cost & AI (cost comparison, complexity tiers, token usage, ROI)

### Tech Stack
- React 18 + TypeScript + Vite
- Tailwind CSS (custom design system with gradients)
- AWS Amplify (Cognito authentication)
- Axios (HTTP client)
- Zustand (state management)
- Recharts (data visualization)
- Lucide React (icons)

---

## Data Model

### DynamoDB Claims Table
- **Partition Key**: `claimId` (String)
- **Sort Key**: `timestamp` (Number)
- All CRUD operations must query first to retrieve both keys

### Key Fields
| Field | Description |
|-------|-------------|
| `status` | submitted, processing, approved, denied, escalated |
| `aiInsights` | AI reasoning text |
| `processingDetails` | Full JSON response from Claude (includes processing_path) |
| `documents` | Array of uploaded document metadata |

---

## Security

- **Authentication**: Cognito user pool with 3 groups (role-based access)
- **Frontend Delivery**: CloudFront CDN with HTTPS, private S3 bucket via OAI
- **API Authorization**: Cognito authorizer on API Gateway
- **AI Safety**: Bedrock Guardrails for content filtering and PII protection
- **Encryption**: S3 server-side encryption (SSE-S3), DynamoDB encryption at rest
- **Audit Trail**: Complete processing history stored in DynamoDB
- **Input Validation**: Field length limits, format checks, and regex-based prompt injection detection on claim submission

---

## Deployment

3 consolidated CDK stacks deployed via `cdk deploy --all`:

| Stack | Resources |
|-------|-----------|
| LifeInsuranceInfraStack | S3 buckets, DynamoDB, Cognito, CloudFront, OpenSearch, KBs, Guardrail |
| LifeInsuranceAgentStack | ECR repos, CodeBuild, 6 AgentCore Runtimes (ARM64) |
| LifeInsuranceApiStack | API Gateway, 5 Lambda functions, EventBridge event bus + rules, CloudWatch monitoring |

See [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) for complete deployment steps.
See [scripts/deploy.sh](../scripts/deploy.sh) for the automated deployment script.

---

## Cost Estimates (Development)

| Service | Monthly Cost |
|---------|-------------|
| OpenSearch Serverless | $100–200 |
| Bedrock API Calls | $30–50 |
| Lambda | $10–20 |
| DynamoDB | $5–10 |
| S3 + CloudFront | $5–10 |
| Other (API GW, CloudWatch, ECR) | $10–20 |
| **Total** | **$160–305** |


---

## Production Extensions

The architecture supports progressive enhancement without restructuring the agent pipeline:

| Extension | Integration Point | AWS Services |
|-----------|-------------------|--------------|
| Multimodal document processing | Extractor agent — replace text-only ingestion with OCR + image analysis | Amazon Textract, Bedrock Data Automation, Claude Vision |
| Medical entity extraction | Extractor agent — structured ICD-10 code extraction from physician statements | Amazon Comprehend Medical |
| ML fraud scoring | Fraud Detection agent — supplement LLM reasoning with trained models | SageMaker (XGBoost/AutoML), S3 (training data from historical claims) |
| Cross-claim intelligence | All agents — retrieve related claim patterns before processing | OpenSearch Serverless (vector index), Bedrock Knowledge Bases |
| Automated SIU workflows | Post-adjudication — trigger investigation workflows on fraud patterns | Step Functions, EventBridge rules, SNS |
| Continuous learning | Feedback loop — adjuster overrides retrain fraud and risk models | SageMaker Pipelines, CloudWatch custom metrics |

The agent IAM roles already include `textract:AnalyzeDocument` and `comprehendmedical:DetectEntitiesV2` permissions — these services can be integrated into the Extractor agent without infrastructure changes.

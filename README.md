# Insurance Claims Processing — Agentic AI Solution

[![Built with Kiro](https://img.shields.io/badge/Built_with-Kiro-6236FF?style=flat&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzcuNTggMiA0IDUuNTggNCAxMHY4LjVjMCAuODMuNjcgMS41IDEuNSAxLjVzMS4wOC0uMzkgMS4zNS0uODVjLjI3LS40Ni43Ny0uNjUgMS4xNS0uNjVzLjg4LjE5IDEuMTUuNjVjLjI3LjQ2Ljc3Ljg1IDEuMzUuODVzMS4wOC0uMzkgMS4zNS0uODVjLjI3LS40Ni43Ny0uNjUgMS4xNS0uNjVzLjg4LjE5IDEuMTUuNjVjLjI3LjQ2Ljc3Ljg1IDEuMzUuODVzMS4wOC0uMzkgMS4zNS0uODVjLjI3LS40Ni43Ny0uNjUgMS4xNS0uNjVzLjg4LjE5IDEuMTUuNjVjLjI3LjQ2Ljc3Ljg1IDEuMzUuODVzMS41LS42NyAxLjUtMS41VjEwYzAtNC40Mi0zLjU4LTgtOC04em0tMyA5YTEuNSAxLjUgMCAxMTAtMyAxLjUgMS41IDAgMDEwIDN6bTYgMGExLjUgMS41IDAgMTEwLTMgMS41IDEuNSAwIDAxMCAzeiIvPjwvc3ZnPg==)](https://kiro.dev)

> A sample implementation demonstrating how agentic AI can accelerate life insurance death benefits claims processing. This demo showcases one approach to multi-agent orchestration using Amazon Bedrock AgentCore — six specialist agents handle identity verification, document extraction, policy validation, fraud detection, and adjudication. Use this as a reference architecture and starting point; production deployments should add hardening, compliance controls, and integrations appropriate to your regulatory environment.

[![AWS](https://img.shields.io/badge/AWS-Bedrock-orange)](https://aws.amazon.com/bedrock/)
[![Python](https://img.shields.io/badge/Python-3.11-blue)](https://www.python.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.2-blue)](https://www.typescriptlang.org/)

## What It Does

- **Orchestrates 6 AI agents** in a 4-phase parallel pipeline (Authenticate + Extract, Policy Verify + Fraud Detect, Adjudicate, Synthesize) to process claims from submission to decision
- **Makes structured decisions** (approve, deny, escalate) with transparent reasoning, confidence scores, and fraud risk assessment — grounded in policy data and uploaded documents
- **Communicates with empathy** — AI responses acknowledge bereavement, with heightened sensitivity for military/combat losses and referrals to SGLI/VA benefits
- **Enforces compliance** via Amazon Bedrock Guardrails (content filtering, PII anonymization, prompt attack detection) and application-layer input validation
- **Three role-based portals** — Claimant submission + AI chatbot, Adjuster review workbench with 8-step AI flow visualization, Business analytics dashboard with real-time metrics
- **9 pre-configured test scenarios** with Demo Quick-Fill dropdown — covering auto-approve, auto-deny (lapsed policy, fraud, exclusions), and human escalation paths
- **Event-driven processing** via Amazon EventBridge with Dead Letter Queue, retry logic, and claim resubmission workflow
- **Document verification** — AI reads uploaded documents (death certificates, medical records, IDs) and includes findings in adjudication. Plain text in demo; architecture supports Textract/Comprehend Medical for production (see Production Evolution Path)
- **One-click deployment** — Automated `deploy.sh` handles CDK infrastructure, Docker agent builds, Knowledge Base setup, and frontend deployment

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Frontend (React + Tailwind)                  │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  Claimant    │  │  Adjuster        │  │  Business        │   │
│  │  Portal      │  │  Workbench       │  │  Dashboard       │   │
│  │  + Chatbot   │  │  + AI Flow Panel │  │                  │   │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘   │
└─────────┼──────────────────┼──────────────────────┼──────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│              CloudFront CDN + API Gateway (Cognito Auth)         │
└──────────────────────────────────┬───────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Claims Lambda   │ │ Documents Lambda │ │  Metrics Lambda  │ │   Chat Lambda    │
│  (CRUD + Events) │ │  (Upload/List)   │ │  (Analytics)     │ │  (FAQ Chatbot)   │
└────────┬─────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
         │
         │  EventBridge: ClaimSubmitted / ClaimResubmitted
         ▼
┌──────────────────────────────────────────────────────────────────┐
│              Amazon EventBridge (claims-processing-bus)          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              ProcessClaim Lambda                                 │
│                                                                  │
│  1. Deterministic document check (S3 scan for required types)   │
│     - Missing docs? → ESCALATE immediately (no AI call)         │
│                                                                  │
│  2. All docs present? → Invoke AgentCore Supervisor             │
│     (6-agent multi-agent pipeline)                              │
│     Fallback: Bedrock InvokeModel if AgentCore unavailable      │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Bedrock AgentCore — 6 Specialist Agents (ECR, ARM64)           │
│                                                                  │
│  Supervisor orchestrates 4-phase parallel pipeline:             │
│  Phase 1 (parallel): Authenticator + Extractor                  │
│  Phase 2 (parallel): Policy Verification + Fraud Detection      │
│  Phase 3 (sequential): Adjudication (needs all prior results)   │
│  Phase 4 (sequential): Synthesize final JSON decision           │
│                                                                  │
│  Each agent uses Claude via Bedrock InvokeModel internally      │
│  Knowledge Bases (RAG): Policy, Fraud Patterns, Regulatory      │
│                                                                  │
│  Outputs: decision, confidence, reasoning, fraud_score          │
│                                                                  │
│  Decision Rules:                                                 │
│  • Auto-Approve: fraud < 0.3, policy active, amount < $100K    │
│  • Auto-Deny: policy lapsed, excluded cause, fraud > 0.7       │
│  • Escalate: amount >= $100K, fraud 0.5-0.7                    │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  DynamoDB (Claims)  │  S3 (Documents)  │  Cognito (Auth)        │
└──────────────────────────────────────────────────────────────────┘
```

### How Claim Processing Works

1. Claimant submits a claim via the portal (or uses Demo Quick-Fill dropdown)
2. Claims Lambda creates the record in DynamoDB with status `submitted`
3. Claims Lambda emits a `ClaimSubmitted` event to EventBridge
4. EventBridge rule triggers the ProcessClaim Lambda asynchronously
5. ProcessClaim Lambda waits 5s for document uploads, then runs a deterministic document completeness check against S3
6. If required documents are missing (death certificate, medical records, beneficiary ID) → escalates immediately without calling AI
7. If all documents present → invokes the **AgentCore Supervisor** which orchestrates 6 specialist agents in a 4-phase parallel pipeline:
   - Phase 1: Authenticator (validate beneficiary) + Extractor (parse documents)
   - Phase 2: Policy Verification (check coverage) + Fraud Detection (score risk)
   - Phase 3: Adjudication (apply decision rules)
   - Phase 4: Synthesize final structured JSON decision
8. If AgentCore is unavailable → falls back to direct Bedrock InvokeModel with the same decision logic
9. AI returns a structured JSON decision: `approved`, `denied`, or `escalated` — with empathetic reasoning for bereaved families
10. DynamoDB is updated with the decision, reasoning, fraud score, and AI insights
11. Claimant sees the result; escalated claims appear in the Adjuster Workbench
12. For resubmissions: claimant uploads missing docs, resubmits → `ClaimResubmitted` event → same pipeline re-evaluates

## User Portals

### Claimant Portal (`claimant1` / `Test123!Pass`)
- Submit new claims with document upload (multi-file)
- Demo Quick-Fill dropdown auto-fills all 9 test scenarios
- Track claim status in real-time (submitted → processing → approved/denied/escalated)
- View AI decision reasoning and document verification findings on claim details page
- AI Claims Assistant chatbot (auto-opens) for FAQ guidance on required documents, process steps, and timelines

### Adjuster Workbench (`adjuster1` / `Test123!Pass`)
- Split claims queue: **Requires Action** (escalated, resubmitted) with notification counter, and **Completed** (approved, denied) for reference
- Resubmitted claims highlighted with "UPDATED" badge and priority review notification
- Escalation Reason panel explaining why a claim was escalated (amount threshold, fraud score, missing docs)
- Full claim details: policy number, beneficiary, relationship, date/cause of death
- AI Processing Flow sidebar — 8-step multi-agent pipeline visualization with real-time status
- AI Insights panel with reasoning, confidence score, fraud score, and document verification badges
- Documents on File panel with real-time S3 polling and required document checklist
- One-click approve/deny with claims removed from queue after action
- Auto-polls while claims are processing to show live step progression

### Business Dashboard (`business1` / `Test123!Pass`)
- Tabbed interface with 4 focused views:
  - **Overview**: Executive KPIs (total claims, STP rate, avg processing time, fraud detected), status donut chart, pipeline bar
  - **Operations**: Real-time processing with 10s auto-refresh, live claims feed, processing pipeline visualization
  - **Analytics**: Decision distribution charts, claims by amount range, fraud score breakdown, AI performance metrics
  - **Cost & AI**: AI vs manual cost comparison, complexity tier breakdown, token usage, ROI metrics

## Test Scenarios

All 9 scenarios are available via the Demo Quick-Fill dropdown on the Submit Claim page:

| # | Scenario | Amount | Key Trigger | Expected Outcome |
|---|----------|--------|-------------|-----------------|
| 1 | Clean claim (natural death) | $25,000 | All criteria met | ✅ Auto-Approved |
| 2 | Lapsed policy | $30,000 | Policy lapsed 6 months ago | ❌ Auto-Denied |
| 3 | Suspicious timing & fraud | $45,000 | Policy 83 days old, 10x increase | ❌ Auto-Denied (Fraud) |
| 4 | High-value clean claim | $150,000 | Amount ≥ $100K threshold | ⏸️ Escalated (Manual Review) |
| 5 | Incomplete submission | $35,000 | Missing death cert & medical records | ⏸️ Escalated (Pending Docs) |
| 6 | Suicide within contestability | $40,000 | Excluded cause + misrepresentation | ❌ Auto-Denied (Exclusion) |
| 7 | Undisclosed pre-existing conditions | $28,000 | Fraud score 0.5–0.8 | ⏸️ Escalated (Manual Review) |
| 8 | Grace period death | $45,000 | Death within 31-day grace period | ✅ Approved (grace period) |
| 9 | War/terrorism exclusion | $50,000 | Death in military combat zone | ❌ Auto-Denied (Exclusion) |

See [docs/DEMO_TESTING_GUIDE.md](docs/DEMO_TESTING_GUIDE.md) for detailed walkthrough of each scenario.

## Quick Start

### Important Notice

> You are responsible for the cost of the AWS services used while running this
> sample deployment. There is no additional cost for using this sample. For full
> details, see the pricing pages for each AWS service you will be using in this
> sample. Prices are subject to change.

### Prerequisites
- AWS Account with Bedrock model access (Claude Sonnet-class or newer, Titan Embeddings)
- Node.js 18+, Python 3.11+, AWS CLI, AWS CDK CLI

### Deploy

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for complete deployment steps, or use the automated script:

```bash
# Full deployment (7 phases)
bash scripts/deploy.sh

# Or manually:
# 1. Select AI model (scans available models, flags legacy, recommends best)
source .venv/bin/activate
python3 scripts/select_model.py

# 2. Deploy infrastructure (3 CDK stacks)
cd backend/infrastructure
npm install
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
cdk deploy --all --require-approval never --outputs-file outputs.json

# 3. Create OpenSearch indices (run in parallel during deploy)
python3 create_indices.py

# 4. Load knowledge base data
cd ../knowledge-bases
python3 load_knowledge_bases.py

# 5. Create Cognito users (claimant1, adjuster1, business1)

# 6. Build and deploy frontend
cd ../../frontend
# Create .env with API_URL, USER_POOL_ID, USER_POOL_CLIENT_ID from outputs.json
npm install && npm run build
aws s3 sync dist/ s3://<YOUR_FRONTEND_BUCKET> --delete
aws cloudfront create-invalidation --distribution-id <YOUR_CLOUDFRONT_DIST_ID> --paths "/*"
```

## Model Configuration

The AI model used for claims processing is configurable. The system scans your Bedrock model access, flags deprecated (LEGACY) models, and recommends the best available option.

### During Initial Deployment

Model selection runs automatically as part of `deploy.sh`. You'll see a table of available models with status indicators and choose one interactively. The selected model is used for all AI processing (claims adjudication, chatbot, resubmission analysis).

### Switching Models After Deployment

To change the model on an existing deployment without redeploying infrastructure:

```bash
bash scripts/switch_model.sh
```

This will:
1. Scan available Bedrock models and show recommendations
2. Flag any LEGACY models with end-of-life dates
3. Update all Lambda functions with the new model ID immediately

Options:
- `--non-interactive` — auto-select the recommended model (useful for CI/CD)
- `--region us-west-2` — target a specific region

### Model Tiers

| Tier | Best For | Cost |
|------|----------|------|
| Opus | Complex reasoning, orchestration | Highest |
| Sonnet | Claims adjudication, document analysis | Balanced |
| Haiku | FAQ chatbot, simple tasks | Lowest |

The demo defaults to Sonnet-tier for a good balance of capability and cost.

## Technology Stack

### Backend
- Amazon Bedrock (configurable Claude model via InvokeModel)
- Amazon Bedrock AgentCore (6 runtimes, ECR-based ARM64 containers via CodeBuild)
- AWS Lambda (Python 3.11) — Claims, ProcessClaim, Documents, Metrics, Chat handlers
- Amazon EventBridge (event-driven claim processing and resubmission)
- Amazon DynamoDB (composite key: claimId + timestamp)
- Amazon S3 (documents storage, frontend, knowledge bases)
- Amazon API Gateway (REST, Cognito authorizer)
- Amazon CloudFront (frontend CDN with OAI)
- Amazon Cognito (user pool with role-based access)
- Amazon OpenSearch Serverless (vector DB for Knowledge Bases)
- Bedrock Knowledge Bases (3: Policy, Fraud, Regulatory)
- Bedrock Guardrails (content filtering, PII protection)
- AWS CDK (TypeScript, 3 consolidated stacks)
- AWS CodeBuild (ARM64 Docker image builds for AgentCore)
- Amazon ECR (6 container image repositories)

### Frontend
- React 18 + TypeScript + Vite
- Tailwind CSS (custom design system)
- AWS Amplify (Cognito auth)
- Axios (API client)
- Zustand (state management)
- Recharts (dashboard visualizations)
- Lucide React (icons)

### AI/ML
- Claude Sonnet-class (configurable via `scripts/select_model.py`) — claim adjudication
- Titan Embeddings — Knowledge Base vector embeddings
- Bedrock Guardrails — content filtering, PII anonymization
- Bedrock Knowledge Bases — RAG for policies, fraud patterns, regulations

## Deployed Resources

| Resource | Details |
|----------|---------|
| CloudFormation Stacks | 3 (Infra, Agent, API) |
| Lambda Functions | 5 API handlers (claims, process-claim, documents, metrics, chat) |
| AgentCore Runtimes | 6 (Supervisor + 5 specialists, ECR-based ARM64) |
| ECR Repositories | 6 (one per agent) |
| CodeBuild Project | 1 (builds all 6 ARM64 Docker images) |
| DynamoDB Tables | 2 (claims, metrics) |
| S3 Buckets | 3 (documents, frontend, knowledge bases) |
| CloudFront Distribution | 1 (frontend CDN) |
| API Gateway | 1 REST API |
| Cognito User Pool | 1 (3 groups: Claimants, Adjusters, BusinessUsers) |
| OpenSearch Collection | 1 (3 vector indices) |
| Knowledge Bases | 3 (Policy, Fraud, Regulatory) |
| Bedrock Guardrail | 1 |

## Deployed Environment

After deployment, your environment-specific values will be in `backend/infrastructure/outputs.json`.

| Resource | Value |
|----------|-------|
| Frontend URL | `https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net` |
| API URL | `https://<YOUR_API_GATEWAY_ID>.execute-api.<YOUR_REGION>.amazonaws.com/prod/` |
| Region | us-east-1 (default) |
| AI Model | Configurable via `scripts/select_model.py` (default: Claude Sonnet 4) |

## API Reference

```
POST   /claims              - Submit new claim (triggers async AI processing)
GET    /claims              - List all claims
GET    /claims/{id}         - Get claim details
PUT    /claims/{id}         - Update claim
POST   /claims/{id}/approve - Approve claim (adjuster)
POST   /claims/{id}/deny    - Deny claim (adjuster)
POST   /claims/{id}/resubmit - Resubmit claim with additional docs (claimant)
POST   /claims/{id}/documents - Upload documents
GET    /claims/{id}/documents - List documents
GET    /metrics/dashboard   - Dashboard metrics (stats, STP rate, recent claims)
GET    /metrics/breakdown   - Claims breakdown by amount
POST   /chat                - FAQ chatbot (claimant guidance, powered by Bedrock)
```

## Documentation

| Document | Purpose |
|----------|---------|
| [START_HERE.md](START_HERE.md) | Quick orientation and navigation |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Complete deployment steps, troubleshooting, cleanup |
| [docs/ARCHITECTURE_DEEP_DIVE.md](docs/ARCHITECTURE_DEEP_DIVE.md) | Detailed architecture, every component, claims logic for every outcome |
| [docs/DEMO_TESTING_GUIDE.md](docs/DEMO_TESTING_GUIDE.md) | All 9 test scenarios with expected outcomes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Enterprise roadmap — omnichannel, Lex, Connect, QuickSight, integrations |
| [DEPLOYMENT ARTIFACTS/03_TROUBLESHOOTING.md](DEPLOYMENT%20ARTIFACTS/03_TROUBLESHOOTING.md) | 27 lessons learned from actual deployments |

## Security Note

This repository enforces Multi-Factor Authentication (MFA) via TOTP for all users. On first login, each user is prompted to set up their authenticator app (Google Authenticator, Authy, 1Password, etc.) by scanning a QR code or entering a secret key manually. Subsequent logins require both the password and a 6-digit TOTP code.

Default demo credentials (`Test123!Pass`) are provided for three Cognito test users (`claimant1`, `adjuster1`, `business1`) across documentation and deployment scripts. These credentials are only meaningful within your own deployed Cognito User Pool and pose no risk to other environments. After deployment, you should change these passwords via the AWS Cognito console or CLI before exposing the application beyond demo/testing use.

## Demo Limitations & Production Considerations

This solution is a functional demonstration of AI-powered claims processing. For production use, the following areas require additional hardening:

| Feature | Demo Behavior | Production Implementation |
|---------|---------------|---------------------------|
| **Policy Database** | In-memory Python dictionary (`POLICY_DATABASE` in claims_handler.py) with 9 pre-seeded policies. | Connect to an actual policy management system (e.g., DynamoDB table, external API, or legacy mainframe integration) with real-time policy status lookups. |
| **Document Verification** | AI reads plain text document content and cross-references claim data. No OCR, image processing, or handwriting recognition. | See Production Evolution Path below — add Textract, Comprehend Medical, Claude Vision, and Bedrock Data Automation for multimodal document processing. |
| **MCP Server Data** | Not applicable — all data is self-contained in DynamoDB and S3. | For enterprise integration, add MCP servers for external data feeds (mortality databases, fraud registries, policy admin systems). |
| **Self-Signup** | Cognito allows self-registration (required for demo Quick-Fill scenarios). | Disable self-signup. Use admin-created accounts with enterprise SSO (SAML/OIDC) federation. |
| **IAM Permissions** | Per-function least-privilege roles. Each Lambda has its own role scoped to only the resources it needs (e.g., ChatHandler can only invoke Bedrock, MetricsHandler has read-only DDB access). | Already implemented. For additional hardening: add resource-level conditions (e.g., `aws:SourceArn`), implement IAM Access Analyzer continuous monitoring. |
| **Separation of Duties** | Single adjuster can approve/deny without peer review. Audit trail records `actionBy`. | Implement dual-approval workflow — initiator cannot be the same as approver. Add supervisor override with escalation. |
| **VPC/Network** | Serverless Lambda without VPC. Bedrock APIs accessed over public internet (AWS backbone). | Deploy Lambda in VPC with PrivateLink endpoints for Bedrock, DynamoDB, and S3. Add VPC Flow Logs. |
| **Structured Logging** | `print()` statements output to CloudWatch Logs. | Migrate to Python `logging` module with JSON structured format. Add correlation IDs, trace context (X-Ray), and log-level filtering. |
| **WAF** | Rate limiting at API Gateway layer (100 burst/50 sustained). No WAF configured. | Add AWS WAF on both CloudFront and API Gateway with managed rule groups (SQL injection, XSS, bot control, rate-based rules). Required for regulated financial applications handling PII. |
| **Disaster Recovery** | Single-region deployment. DynamoDB PITR enabled. S3 versioned. | Multi-region active-passive with DynamoDB Global Tables, S3 Cross-Region Replication, and Route 53 failover. |
| **Chat Guardrails** | Bedrock Guardrail (`CCOEDeathBenefitsGuardrail`) applied to chat input via `ApplyGuardrail` API. Blocks prompt injection and word policy violations while allowing legitimate claims questions. | Already implemented. For additional hardening: add output filtering, implement rate limiting per user on the chat endpoint. |
| **OpenSearch Network Policy** | Configurable via CDK context flag `opensearch_public_access`. Defaults to restricted (false) for new deployments. Demo uses explicit opt-in (`cdk.json` sets `true`). | For production: remove context flag, enforce VPC endpoint access only. RAG embeddings should not be reachable outside the application layer. |
| **ECR Image Security** | Agent container images pushed without vulnerability scanning; mutable `:latest` tags used. | Enable ECR image scanning on push, enforce tag immutability, and use digest-pinned image references. Prevents supply chain compromise in the AI pipeline. |
| **Document Upload Limits** | No server-side file size enforcement on document uploads. | Add `Content-Length` validation in the upload handler (e.g., 10MB max). Prevents cost abuse via arbitrarily large files filling S3 and triggering storage quotas. |
| **EventBridge Resource Policy** | `claims-processing-bus` relies solely on IAM grants with no explicit resource policy. | Add an EventBridge resource policy restricting `PutEvents` to specific source ARNs. Provides defense-in-depth against event injection if an adjacent role is compromised. |
| **Prompt Injection Detection** | 5 English-only regex patterns in `INJECTION_PATTERNS`. Misses encoded payloads and multilingual attacks. | Replace with layered defense: structural input validation + LLM-based classifier + Bedrock Guardrails content filters. Cover base64 encoding, Unicode obfuscation, and multilingual jailbreak techniques. |

### Production Evolution Path

This demo showcases the multi-agent orchestration pattern. Production deployments would extend it with ML models, multimodal document processing, and autonomous learning:

| Capability | Demo Approach | Production Extension |
|-----------|---------------|----------------------|
| **Multimodal Document Processing** | Uploaded documents are plain text files. AI reads text content directly. No OCR, no image processing, no handwriting recognition. | Add Amazon Textract for scanned PDFs and handwritten forms. Use Bedrock Data Automation for document classification (death certificate vs. medical record vs. ID). Send document images to Claude's vision capability to detect signatures, stamps, watermarks, and alterations. Integrate Amazon Comprehend Medical for ICD code extraction from physician statements. |
| **ML-Powered Risk Scoring (SageMaker)** | LLM-only decision making based on prompt reasoning. | Deploy SageMaker endpoints for claims risk scoring (trained on historical adjudication outcomes), fraud probability models (features: claim patterns, timing, amounts), and processing time prediction. Feed ML scores to agents as structured input alongside RAG context. |
| **Self-Healing & Continuous Learning** | Each claim processed independently. No feedback from adjuster overrides. | Track overturn rate (claims where adjusters override AI decisions). Auto-retrain when override rate exceeds threshold. Auto-requeue claims on transient agent failures. Build automated SIU (Special Investigations Unit) workflow triggered by fraud score patterns. |
| **Semantic Memory** | No cross-claim intelligence. Each claim evaluated in isolation. | Vector-index fraud investigation outcomes and claim patterns. Enable cross-claim relationship detection (same beneficiary filing multiple claims, same physician across suspicious claims). Historical decision retrieval for consistency. |
| **Episodic Memory** | No cross-session continuity. | Store complete claim processing episodes (submission → documents → agent reasoning → decision → adjuster action → outcome). Enables regulatory audit replay, pattern learning across claim types, and adjuster training from AI decision examples. |

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for information about reporting security issues.

## Cleanup

To avoid ongoing AWS charges, destroy all resources when done:

```bash
cd backend/infrastructure
cdk destroy --all --force
```

CDK handles most resources, but verify these are fully removed:

```bash
# Delete ECR images (may persist if CDK destroy fails mid-way)
aws ecr describe-repositories --query 'repositories[?starts_with(repositoryName, `life-insurance/`)].repositoryName' --output text | \
  xargs -I{} aws ecr delete-repository --repository-name {} --force

# Verify S3 buckets are deleted (CDK autoDeleteObjects handles this, but confirm)
aws s3 ls | grep life-insurance

# Verify OpenSearch Serverless collection is deleted
aws opensearchserverless list-collections --query 'collectionSummaries[?name==`life-insurance-kb`]'

# Delete Cognito test users (if user pool persists)
# aws cognito-idp admin-delete-user --user-pool-id <POOL_ID> --username claimant1
```

---

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

---

Built with Amazon Bedrock, AgentCore, and Claude for the insurance industry.

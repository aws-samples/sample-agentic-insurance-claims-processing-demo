# CCOE Insurance Industry LLC — Documentation Index

## System Overview

AI-powered death benefits claims processing system built on AWS. Claims are adjudicated by 6 specialist agents on Bedrock AgentCore via a 4-phase parallel pipeline, with direct Bedrock InvokeModel as fallback.

### Key Features
- AI claim adjudication (approve/deny/escalate) in 2–10 seconds
- Three role-based portals: Claimant, Adjuster, Business Dashboard
- AI Claims Assistant chatbot (empathetic FAQ guidance, claimant-only)
- Document verification (AI reads uploaded documents during adjudication)
- AI Processing Flow visualization (8-step pipeline in Adjuster Workbench)
- 9 pre-configured demo scenarios with Demo Quick-Fill
- Business Dashboard with cost-by-complexity analytics, token usage, and AI cost breakdown
- Real-time metrics and claims overview

---

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE_DEEP_DIVE.md](ARCHITECTURE_DEEP_DIVE.md) | Detailed architecture, every component, claims logic for every outcome |
| [QUICKSTART.md](QUICKSTART.md) | Get running in under 60 minutes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, AWS services, data flow |
| [ARCHITECTURE_DEEP_DIVE.md](ARCHITECTURE_DEEP_DIVE.md) | Detailed walkthrough of every component, scenario logic, cost model |
| [CLAIMS_PROCESS_QUICK_REFERENCE.md](CLAIMS_PROCESS_QUICK_REFERENCE.md) | Decision rules, statuses, fraud indicators |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) | Deployment phases, configuration, troubleshooting |
| [DEMO_TESTING_GUIDE.md](DEMO_TESTING_GUIDE.md) | All 9 test scenarios with expected outcomes |
| [ROADMAP.md](ROADMAP.md) | Enterprise roadmap — omnichannel, Lex, Connect, QuickSight, 3rd-party integrations |
| [QUICKSIGHT_INTEGRATION_EFFORT.md](QUICKSIGHT_INTEGRATION_EFFORT.md) | QuickSight integration effort analysis and work breakdown |
| [LEX_CONNECT_INTEGRATION_EFFORT.md](LEX_CONNECT_INTEGRATION_EFFORT.md) | Amazon Lex + Connect integration effort analysis and work breakdown |

### Root-Level Documents
| Document | Description |
|----------|-------------|
| [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) | Complete deployment steps (v1.2.0) |
| [README.md](../README.md) | Project overview and quick start |
| [START_HERE.md](../START_HERE.md) | Quick orientation and navigation |

### Deployment Artifacts
| Document | Description |
|----------|-------------|
| [03_TROUBLESHOOTING.md](../DEPLOYMENT%20ARTIFACTS/03_TROUBLESHOOTING.md) | 27 lessons learned from actual deployments |

---

## Architecture Summary

```
Frontend (React + Tailwind) → CloudFront → API Gateway (Cognito Auth)
    → Claims Lambda (CRUD + EventBridge events)
    → Documents Lambda (S3 upload/list)
    → Metrics Lambda (dashboard analytics)
    → Chat Lambda (FAQ chatbot)

AI Processing:
    EventBridge → ProcessClaim Lambda → Deterministic doc check
    → AgentCore Supervisor (6-agent parallel pipeline) [PRIMARY]
    → Bedrock InvokeModel [FALLBACK]
    → DynamoDB updated with result
```

### AWS Services
Amazon Bedrock (Claude, configurable model), Bedrock AgentCore (6 runtimes), Amazon EventBridge, Bedrock Knowledge Bases (3), Bedrock Guardrails, AWS Lambda (5 handlers), DynamoDB, S3, CloudFront, API Gateway, Cognito, OpenSearch Serverless, AWS CDK (3 stacks)

### Frontend Tech
React 18, TypeScript, Vite, Tailwind CSS, AWS Amplify, Axios, Zustand, Lucide React

---

## API Endpoints

```
POST   /claims                  - Submit new claim (triggers async AI processing)
GET    /claims                  - List all claims
GET    /claims/{id}             - Get claim details
PUT    /claims/{id}             - Update claim
POST   /claims/{id}/approve     - Approve claim (adjuster)
POST   /claims/{id}/deny        - Deny claim (adjuster)
POST   /claims/{id}/documents   - Upload documents
GET    /claims/{id}/documents   - List documents
GET    /metrics/dashboard       - Dashboard metrics
GET    /metrics/breakdown       - Claims breakdown
POST   /chat                    - FAQ chatbot
```

---

## Test Users

| Username | Password | Role |
|----------|----------|------|
| `claimant1` | `Test123!Pass` | Claimant (submit claims, chatbot) |
| `adjuster1` | `Test123!Pass` | Adjuster (review, approve/deny) |
| `business1` | `Test123!Pass` | Business (dashboard, metrics) |

---

## Project Structure

```
├── backend/
│   ├── infrastructure/        # CDK stacks (TypeScript)
│   │   └── lib/
│   │       ├── infrastructure-stack.ts  # Infra + KBs + Guardrail
│   │       ├── agent-stack.ts           # ECR + CodeBuild + AgentCore
│   │       └── api-stack.ts             # API Gateway + Lambda + CW role
│   ├── lambda/                # Lambda handlers (Python)
│   │   ├── claims/            # Claims CRUD + AI processing
│   │   ├── documents/         # S3 upload/list
│   │   ├── metrics/           # Dashboard analytics
│   │   └── chat/              # FAQ chatbot
│   ├── agents/                # AgentCore agent source code (6 agents)
│   └── knowledge-bases/       # RAG data for Knowledge Bases
├── frontend/                  # React application
│   └── src/
│       ├── pages/
│       │   ├── Auth/Login.tsx
│       │   ├── ClaimantPortal/
│       │   ├── AdjusterWorkbench/
│       │   └── BusinessDashboard/
│       ├── components/
│       │   ├── Layout/
│       │   └── ChatWidget/
│       ├── services/api.ts
│       └── stores/authStore.ts
├── test-data/                 # 9 demo scenarios + documents
├── docs/                      # This documentation folder
└── DEPLOYMENT ARTIFACTS/      # Deployment guides + troubleshooting
```

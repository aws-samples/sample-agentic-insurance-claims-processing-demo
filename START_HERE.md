# Start Here — CCOE Insurance Industry LLC

---

## What Is This?

An AI-powered life insurance death benefits claims processing system built on AWS. Claude (configurable model) automatically adjudicates claims, detects fraud, verifies documents, and routes complex cases to human adjusters.

**Live Demo**: `https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net`

---

## Quick Navigation

| I want to... | Go to |
|---------------|-------|
| Understand the system | [README.md](README.md) |
| See the full architecture and claims logic | [docs/ARCHITECTURE_DEEP_DIVE.md](docs/ARCHITECTURE_DEEP_DIVE.md) |
| Deploy from scratch | [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) |
| Run the demo scenarios | [docs/DEMO_TESTING_GUIDE.md](docs/DEMO_TESTING_GUIDE.md) |
| See the enterprise roadmap | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Troubleshoot issues | [DEPLOYMENT ARTIFACTS/03_TROUBLESHOOTING.md](DEPLOYMENT%20ARTIFACTS/03_TROUBLESHOOTING.md) |

---

## Test Users

| Username | Password | Role | What They See |
|----------|----------|------|---------------|
| claimant1 | Test123!Pass | Claimant | Submit claims, track status, AI chatbot |
| adjuster1 | Test123!Pass | Adjuster | Review claims, AI processing flow, approve/deny |
| business1 | Test123!Pass | Business | Dashboard metrics, cost analytics, token usage |

---

## Deployed Environment

After deployment, your environment values will be in `backend/infrastructure/outputs.json`:

| Resource | Value |
|----------|-------|
| Frontend | `https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net` |
| API | `https://<YOUR_API_GATEWAY_ID>.execute-api.<YOUR_REGION>.amazonaws.com/prod/` |
| Region | us-east-1 (default) |
| AI Model | Configurable via `scripts/select_model.py` (defaults to Claude Sonnet-class) |

---

## Redeployment

```bash
# Frontend (use values from outputs.json)
cd frontend && npm run build
aws s3 sync dist/ s3://<YOUR_FRONTEND_BUCKET> --delete
aws cloudfront create-invalidation --distribution-id <YOUR_CLOUDFRONT_DIST_ID> --paths "/*"

# Lambda (from project root)
zip -j /tmp/claims_handler.zip backend/lambda/claims/claims_handler.py
aws lambda update-function-code --function-name LifeInsuranceClaimsHandler --zip-file fileb:///tmp/claims_handler.zip --region us-east-1

zip -j /tmp/metrics_handler.zip backend/lambda/metrics/metrics_handler.py
aws lambda update-function-code --function-name LifeInsuranceMetricsHandler --zip-file fileb:///tmp/metrics_handler.zip --region us-east-1

zip -j /tmp/chat_handler.zip backend/lambda/chat/chat_handler.py
aws lambda update-function-code --function-name LifeInsuranceChatHandler --zip-file fileb:///tmp/chat_handler.zip --region us-east-1

# CDK stacks
cd backend/infrastructure && cdk deploy --all --require-approval never
```

---

## Documentation Map

```
START_HERE.md ← you are here
├── README.md                                — Project overview, architecture, tech stack
├── DEPLOYMENT_GUIDE.md                      — Full deployment steps (v2.1.0)
├── docs/
│   ├── ARCHITECTURE_DEEP_DIVE.md            — Detailed architecture, components, claims logic
│   ├── DEMO_TESTING_GUIDE.md                — 7 test scenarios + demo walkthrough (v2.2.0)
│   ├── ROADMAP.md                           — Enterprise roadmap (omnichannel, Lex, Connect, QuickSight)
│   ├── ARCHITECTURE.md                      — System architecture overview
│   ├── QUICKSTART.md                        — Get running in 60 minutes
│   ├── IMPLEMENTATION_GUIDE.md              — Deployment phases, configuration
│   ├── END_TO_END_CLAIMS_PROCESS.md         — Full claim processing flow
│   ├── CLAIMS_PROCESS_QUICK_REFERENCE.md    — Decision rules, statuses, fraud indicators
│   └── README.md                            — Documentation index
└── DEPLOYMENT ARTIFACTS/
    └── 03_TROUBLESHOOTING.md                — 27 lessons learned (v3.2.0)
```

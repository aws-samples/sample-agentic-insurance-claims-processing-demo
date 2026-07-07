# Quick Start Guide

Get the system running in under 60 minutes.

## Prerequisites

- [ ] AWS Account with admin access
- [ ] AWS CLI installed and configured
- [ ] Node.js 18+ and npm
- [ ] Python 3.11+
- [ ] AWS CDK CLI: `npm install -g aws-cdk`
- [ ] Bedrock model access enabled (Claude Sonnet-class or newer, Titan Embeddings)

---

## Deploy

### Step 1: Deploy All Stacks (15–25 minutes)

```bash
cd backend/infrastructure
npm install
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
cdk deploy --all --require-approval never --outputs-file outputs.json
```

This deploys 3 stacks: Infrastructure (S3, DynamoDB, Cognito, OpenSearch, KBs, Guardrail), Agents (ECR, CodeBuild ARM64, 6 AgentCore Runtimes), API (API Gateway, Lambda handlers).

### Step 2: Create OpenSearch Indices (run in parallel with Step 1)

In a separate terminal, run this while Step 1 is deploying:

```bash
cd backend/infrastructure
pip3 install boto3 opensearch-py requests-aws4auth
python3 create_indices.py
```

The script polls for the OpenSearch collection to become ACTIVE, then creates vector indices.

### Step 3: Load Knowledge Bases

```bash
cd backend/knowledge-bases
pip3 install -r requirements.txt
python3 load_knowledge_bases.py
python3 sync_knowledge_bases.py
```

### Step 4: Deploy Frontend (10 minutes)

```bash
cd ../../frontend
npm install
```

Create `.env` with values from CDK outputs:
```
VITE_API_URL=https://YOUR_API_URL/prod
VITE_USER_POOL_ID=us-east-1_XXXXXXX
VITE_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXX
VITE_REGION=us-east-1
```

```bash
npm run build
aws s3 sync dist/ s3://FRONTEND_BUCKET --delete
aws cloudfront create-invalidation --distribution-id DIST_ID --paths "/*"
```

### Step 5: Create Test Users

Create these users in Cognito (plain usernames, not email format):
- `claimant1` / `Test123!Pass` → Claimants group
- `adjuster1` / `Test123!Pass` → Adjusters group
- `business1` / `Test123!Pass` → BusinessUsers group

### Step 6: Load Test Data

```bash
cd test-data
pip3 install boto3
python3 load_test_data.py
```

---

## Verify

1. Open the CloudFront URL in your browser
2. Login as `claimant1` / `Test123!Pass`
3. Use the Demo Quick-Fill dropdown to select Scenario 1 (Clean Claim)
4. Submit the claim — should auto-approve in 2–5 seconds
5. Login as `adjuster1` — check the Adjuster Workbench
6. Login as `business1` — check the Business Dashboard

---

## Test Scenarios

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| 1 | Clean claim | ✅ Auto-Approved |
| 2 | Lapsed policy | ❌ Auto-Denied |
| 3 | Fraud indicators | ❌ Auto-Denied |
| 4 | High-value claim | ⏸️ Escalated |
| 5 | Missing documents | ⏸️ Escalated |
| 6 | Suicide exclusion | ❌ Auto-Denied |
| 7 | Undisclosed conditions | ⏸️ Escalated |

See [DEMO_TESTING_GUIDE.md](DEMO_TESTING_GUIDE.md) for detailed walkthroughs.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| CDK deploy fails | Check `aws sts get-caller-identity`, verify Bedrock model access |
| Frontend not loading | Check CloudFront distribution, run S3 sync + invalidation |
| Claims stuck in Processing | Check Lambda logs, verify Bedrock model access for your selected model |
| Login fails | Verify Cognito user pool ID and client ID in `.env` |
| AI returns wrong decisions | Check `POLICY_DATABASE` in `claims_handler.py` for the policy number |

For detailed troubleshooting: [DEPLOYMENT ARTIFACTS/03_TROUBLESHOOTING.md](../DEPLOYMENT%20ARTIFACTS/03_TROUBLESHOOTING.md)

---

## Cost Estimates (Development)

| Service | Monthly |
|---------|---------|
| OpenSearch Serverless | $100–200 |
| Bedrock API Calls | $30–50 |
| Lambda + DynamoDB + S3 | $20–40 |
| Other | $10–20 |
| **Total** | **$160–305** |

---

## Clean Up

```bash
cd backend/infrastructure

# Empty S3 buckets first
aws s3 rm s3://DOCS_BUCKET --recursive
aws s3 rm s3://FRONTEND_BUCKET --recursive

# Destroy all stacks
cdk destroy --all --force
```

---

## Documentation

| Document | Purpose |
|----------|---------|
| [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) | Complete deployment steps |
| [DEMO_TESTING_GUIDE.md](DEMO_TESTING_GUIDE.md) | All 7 test scenarios |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) | Technical details |
| [END_TO_END_CLAIMS_PROCESS.md](END_TO_END_CLAIMS_PROCESS.md) | Full processing flow |

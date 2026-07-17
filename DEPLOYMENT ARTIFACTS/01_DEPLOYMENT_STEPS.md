# Deployment Steps - CCOE Insurance Industry LLC

> **Note**: This document has been consolidated into DEPLOYMENT_GUIDE.md in the root directory. Please use that guide for complete deployment instructions with manual steps.

## 🚀 Deployment Overview

This guide will deploy the complete death benefits claims processing system to your AWS account using 3 CDK stacks with ECR-based AgentCore deployment.

**Estimated Time**: 45-60 minutes  
**Deployment Method**: AWS CDK (TypeScript)  
**Architecture**: 3 consolidated CDK stacks, ECR-based AgentCore with CodeBuild ARM64

---

## 📋 Deployment Phases

1. **Phase 1**: Infrastructure Setup (15-20 min)
2. **Phase 2**: Agent Deployment via ECR/CodeBuild (15-25 min)
3. **Phase 3**: API Deployment (5-10 min)
4. **Phase 4**: Knowledge Base Data Loading (10-15 min)
5. **Phase 5**: Frontend Deployment (10-15 min)
6. **Phase 6**: Test Data & Verification (5-10 min)

---

## Phase 1: Infrastructure Setup

### Step 1.1: Install Dependencies

```bash
cd backend/infrastructure
npm install
```

### Step 1.2: Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

### Step 1.3: Deploy Infrastructure Stack

```bash
cdk deploy LifeInsuranceInfraStack --require-approval never
```

**Expected Duration**: 15-20 minutes

**Resources Created**:
- ✅ S3 Buckets (documents, frontend, knowledge bases)
- ✅ DynamoDB Tables (claims, metrics)
- ✅ Cognito User Pool and Client (3 groups)
- ✅ CloudFront Distribution with OAI
- ✅ OpenSearch Serverless Collection
- ✅ 3 Bedrock Knowledge Bases (Policy, Fraud, Regulatory)
- ✅ Bedrock Guardrail
- ✅ KMS Encryption Key

**IMPORTANT — Run in a separate terminal simultaneously**:
```bash
cd backend/infrastructure
pip3 install boto3 opensearch-py requests-aws4auth
python3 create_indices.py
```

This creates the OpenSearch vector indices. See `03_TROUBLESHOOTING.md` Lessons 6-8 and 24 for details on the KMS/OpenSearch race conditions.

---

## Phase 2: Agent Deployment

### Step 2.1: Deploy Agent Stack

```bash
cdk deploy LifeInsuranceAgentStack --require-approval never
```

**Expected Duration**: 15-25 minutes (includes CodeBuild image builds)

**Resources Created**:
- ✅ 6 ECR Repositories
- ✅ CodeBuild Projects (ARM64 image builds, no local Docker needed)
- ✅ 6 Bedrock AgentCore Runtimes (ECR-based)

**Agents Deployed**:
- Supervisor Agent
- Authenticator Agent
- Extractor Agent
- Policy Verification Agent
- Fraud Detection Agent
- Adjudication Agent

**Note**: AgentCore requires ARM64 (Graviton) images. CodeBuild uses `LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0` with `ComputeType.LARGE` to build these in-cloud.

---

## Phase 3: API Deployment

### Step 3.1: Deploy API Stack

```bash
cdk deploy LifeInsuranceApiStack --require-approval never
```

**Expected Duration**: 5-10 minutes

**Resources Created**:
- ✅ API Gateway REST API with Cognito Authorizer
- ✅ CloudWatch Logs Role (for fresh AWS accounts)
- ✅ Lambda Functions (claims, documents, metrics, chat handlers)

---

## Phase 4: Knowledge Base Data Loading

### Step 4.1: Load Knowledge Base Content

```bash
cd backend/knowledge-bases
pip3 install -r requirements.txt
python3 load_knowledge_bases.py
python3 sync_knowledge_bases.py
```

**Expected Duration**: 5-10 minutes (sync runs asynchronously)

---

## Phase 5: Frontend Deployment

### Step 5.1: Configure and Build

```bash
cd frontend
npm install
```

Create `.env` with values from `backend/infrastructure/outputs.json`:
```
VITE_API_URL=https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/
VITE_AWS_REGION=us-east-1
VITE_USER_POOL_ID=us-east-1_XXXXXXX
VITE_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXX
```

> **Note**: The `frontend/.env` file ships with placeholders (not real values) and is gitignored. You must populate it with your actual deployment values from `outputs.json` before every frontend build. If using `scripts/deploy.sh`, this is handled automatically.

```bash
npm run build
```

### Step 5.2: Deploy to S3

```bash
BUCKET_NAME=$(cat ../backend/infrastructure/outputs.json | python3 -c "import sys,json; print(json.load(sys.stdin)['LifeInsuranceInfraStack']['FrontendBucketName'])")
aws s3 sync dist/ s3://$BUCKET_NAME --delete
```

### Step 5.3: Invalidate CloudFront Cache

```bash
DIST_ID=$(cat ../backend/infrastructure/outputs.json | python3 -c "import sys,json; print(json.load(sys.stdin)['LifeInsuranceInfraStack']['CloudFrontDistributionId'])")
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*"
```

---

## Phase 6: Test Data & Verification

### Step 6.1: Create Test Users

```bash
cd backend
python3 create_test_users.py
```

**Test Users**:
- `claimant1` / `Test123!Pass` → Claimants group
- `adjuster1` / `Test123!Pass` → Adjusters group
- `business1` / `Test123!Pass` → BusinessUsers group

### Step 6.2: Load Test Scenarios

```bash
cd test-data
python3 load_test_scenarios.py
```

---

## 🎉 Deployment Complete!

### Access Information

**Frontend URL**: From `outputs.json` → `LifeInsuranceInfraStack.FrontendURL`  
**API URL**: From `outputs.json` → `LifeInsuranceApiStack.ApiUrl`

---

## 📊 Deployment Summary

**Total Time**: ~45-60 minutes  
**Stacks Deployed**:
- ✅ LifeInsuranceInfraStack (S3, DynamoDB, Cognito, OpenSearch, KBs, Guardrail)
- ✅ LifeInsuranceAgentStack (ECR, CodeBuild, 6 AgentCore Runtimes)
- ✅ LifeInsuranceApiStack (API Gateway, Lambda handlers, CW Logs role)

---

## 🆘 Troubleshooting

See `03_TROUBLESHOOTING.md` for 27 documented lessons learned including:
- KMS key race conditions (Lesson 24)
- OpenSearch wildcard role ARN rejection (Lesson 25)
- AgentCore ARM64 container requirement (Lesson 26)
- API Gateway CloudWatch Logs role for fresh accounts (Lesson 27)

---

**Deployment Completed**: ___________  
**Deployed By**: ___________  
**Date**: ___________  
**AWS Account**: ___________  
**Region**: ___________

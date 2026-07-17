# CCOE Insurance Industry LLC - Deployment Guide

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Manual Deployment Steps](#manual-deployment-steps)
3. [Verification](#verification)
4. [Troubleshooting](#troubleshooting)
5. [Cleanup](#cleanup)
6. [Version History](#version-history)

---

## Prerequisites

### Required Software

Check you have these installed:

```bash
# Check Node.js (need 18+)
node --version

# Check npm
npm --version

# Check Python (need 3.11+)
python3 --version

# Check pip3
pip3 --version

# Check AWS CLI
aws --version

# Check AWS CDK
cdk --version
# If not installed: npm install -g aws-cdk
```

### Python Packages for OpenSearch Index Creation

```bash
# Required for the create_indices.py script (KB stack deployment)
pip3 install boto3 opensearch-py requests-aws4auth
```

### AWS Configuration

```bash
# Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output format (json)

# Verify credentials work
aws sts get-caller-identity
# Should show your account ID and user ARN
```

### Enable Bedrock Models

**IMPORTANT**: You must enable these models before deployment:

1. Go to AWS Console: https://console.aws.amazon.com/bedrock/
2. Click "Model access" in left sidebar
3. Click "Manage model access" button
4. Enable these models:
   - ✅ Claude Sonnet-class (configurable — selected during deployment via scripts/select_model.py)
   - ✅ Titan Embeddings G1 - Text (used for Knowledge Base embeddings)
5. Click "Save changes"
6. Wait for status to show "Access granted" (takes 1-2 minutes)

**Note**: The system uses cross-region inference profiles. Run `scripts/select_model.py` during deployment to scan available models and select an ACTIVE one. LEGACY models are flagged.

---

## Manual Deployment Steps

### Phase 1: Deploy Infrastructure (20-25 minutes)

#### Step 1.1: Deploy CDK Stacks

```bash
# Navigate to infrastructure directory
cd backend/infrastructure

# Install Node.js dependencies
npm install

# Bootstrap CDK (REQUIRED - first time only)
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1

# Example:
# cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1

# Wait for bootstrap to complete (2-3 minutes)

# Deploy all 3 stacks at once
cdk deploy --all --require-approval never --outputs-file outputs.json

# IMPORTANT: In a SEPARATE terminal, run the index creator script in parallel:
#   cd backend/infrastructure
#   pip3 install boto3 opensearch-py requests-aws4auth
#   python3 create_indices.py
#
# This script polls for the OpenSearch collection to become ACTIVE,
# then creates the required vector indices automatically.

# Wait for completion (15-25 minutes)
# Creates:
#   LifeInsuranceInfraStack: S3, DynamoDB, Cognito, CloudFront, OpenSearch, KBs, Guardrail
#   LifeInsuranceAgentStack: ECR repos, CodeBuild (ARM64), 6 AgentCore Runtimes
#   LifeInsuranceApiStack: API Gateway, 4 Lambda functions, CloudWatch monitoring
```

**Record these outputs** (you'll need them later):
- FrontendBucketName
- FrontendURL
- DocumentsBucketName
- ClaimsTableName
- UserPoolId
- UserPoolClientId
- ApiUrl

---

### Phase 2: Load Knowledge Bases (10-15 minutes)

```bash
# Navigate to knowledge bases directory
cd ../knowledge-bases

# Install Python dependencies
pip3 install -r requirements.txt

# Load knowledge base content to S3
python3 load_knowledge_bases.py

# Expected output:
# ✓ Uploaded policy guidelines
# ✓ Uploaded fraud patterns
# ✓ Uploaded regulatory requirements

# Trigger Bedrock Knowledge Base ingestion
python3 sync_knowledge_bases.py

# Expected output:
# ✓ Started ingestion for Policy KB
# ✓ Started ingestion for Fraud KB
# ✓ Started ingestion for Regulatory KB

# Note: Ingestion runs asynchronously (5-10 minutes)
# You can proceed to next phase while it completes
```

---

### Phase 3: Agents (Deployed via CDK — ECR-Based)

**Note**: Agents are deployed as Bedrock AgentCore Runtimes using ECR-based ARM64 containers. The CDK Agent stack (deployed in Phase 1) handles everything:

1. Creates 6 ECR repositories (one per agent)
2. Uploads all agent source code to S3 as a single asset
3. CodeBuild project (ARM64 environment) builds Docker images and pushes to ECR
4. Custom resource Lambda triggers CodeBuild and polls for completion
5. Creates 6 `AWS::BedrockAgentCore::Runtime` resources with `ContainerConfiguration`

All Dockerfiles use `FROM --platform=linux/arm64 python:3.11-slim` — AgentCore requires ARM64 (Graviton) images.

The 6 agents deployed are:
- **Supervisor** — orchestrates the full claims workflow
- **Authenticator** — validates beneficiary identity
- **Extractor** — OCR and document data extraction
- **PolicyVerification** — checks policy status and coverage
- **FraudDetection** — analyzes fraud indicators
- **Adjudication** — makes approval/denial decisions

You can verify them in the AWS Console under **Bedrock → AgentCore → Runtimes**.

---

### Phase 4: Deploy Frontend (10-15 minutes)

```bash
# Navigate to frontend directory
cd ../../frontend

# Install npm dependencies
npm install

# Get outputs from infrastructure deployment
OUTPUTS_FILE="../backend/infrastructure/outputs.json"

# Extract values (or manually copy from outputs.json)
API_URL=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceApiStack.ApiUrl')
USER_POOL_ID=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.UserPoolId')
USER_POOL_CLIENT_ID=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.UserPoolClientId')
FRONTEND_BUCKET=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.FrontendBucketName')
CLOUDFRONT_ID=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.CloudFrontDistributionId')

# Create .env file
cat > .env << EOF
VITE_API_URL=$API_URL
VITE_AWS_REGION=us-east-1
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
EOF

# Build production bundle
npm run build

# Expected output:
# ✓ Built in X seconds
# ✓ dist/ folder created

# Deploy to S3
aws s3 sync dist/ s3://$FRONTEND_BUCKET --delete

# Expected output:
# upload: dist/index.html to s3://...
# upload: dist/assets/... to s3://...

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id $CLOUDFRONT_ID \
  --paths "/*"

# Get frontend URL
FRONTEND_URL=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.FrontendURL')
echo "Frontend URL: $FRONTEND_URL"
```

---

### Phase 5: Load Test Data (5-10 minutes)

```bash
# Navigate to test-data directory
cd ../test-data

# Install Python dependencies (if not already installed)
pip3 install boto3

# Load test scenarios and documents
python3 load_test_data.py

# Expected output:
# Auto-discovers DynamoDB table and S3 bucket from CloudFormation outputs
# ✓ Created scenario CLM-DEMO-001: STP Auto-Approve
# ✓ Created scenario CLM-DEMO-002: Auto-Deny (lapsed policy)
# ✓ Created scenario CLM-DEMO-003: Auto-Deny (high fraud)
# ✓ Created scenario CLM-DEMO-004: Manual Review (high-value)
# ✓ Created scenario CLM-DEMO-005: Pending Documents
# ✓ Created scenario CLM-DEMO-006: Auto-Deny (suicide within contestability)
# ✓ Created scenario CLM-DEMO-007: Manual Review (moderate fraud)
# ✓ Uploaded 15 sample documents to S3
```

Test users were already created during infrastructure deployment (Cognito):

| Username | Password | Role |
|----------|----------|------|
| claimant1 | Test123!Pass | Claimant |
| adjuster1 | Test123!Pass | Adjuster |
| business1 | Test123!Pass | Business |

---

## Verification

### 1. Check CloudFormation Stacks

```bash
aws cloudformation list-stacks --query "StackSummaries[?contains(StackName, 'LifeInsurance')].{Name:StackName, Status:StackStatus}"
```

Expected: All 3 stacks show `CREATE_COMPLETE`

### 2. Check Lambda Functions

```bash
aws lambda list-functions --query "Functions[?contains(FunctionName, 'LifeInsurance')].FunctionName"
```

Expected: 4 functions listed

### 3. Check DynamoDB Tables

```bash
aws dynamodb list-tables --query "TableNames[?contains(@, 'LifeInsurance')]"
```

Expected: 2 tables listed

### 4. Test Frontend

1. Open the frontend URL in your browser
2. Login with: `claimant1` / `Test123!Pass`
3. Submit a test claim
4. Upload a document
5. Verify claim processes

### 5. Test All User Roles

**Claimant Portal**:
- Username: `claimant1`
- Password: `Test123!Pass`
- Can: Submit claims, upload documents, track status

**Adjuster Workbench**:
- Username: `adjuster1`
- Password: `Test123!Pass`
- Can: Review claims, view AI insights, approve/deny

**Business Dashboard**:
- Username: `business1`
- Password: `Test123!Pass`
- Can: View metrics, claims breakdown, performance

---

## Troubleshooting

### Issue: CDK Bootstrap Fails

**Error**: `Unable to resolve AWS account to use`

**Solution**:
```bash
aws configure
aws sts get-caller-identity
cdk bootstrap
```

---

### Issue: Bedrock Access Denied

**Error**: `You don't have access to the model`

**Solution**:
1. Go to Bedrock console
2. Enable model access (see Prerequisites section)
3. Wait for "Access granted" status
4. Retry deployment

---

### Issue: Lambda Function Not Found

**Error**: `Function not found: LifeInsuranceClaims-*`

**Solution**:
```bash
# Redeploy API stack (Lambda handlers for API Gateway)
cd backend/infrastructure
cdk deploy LifeInsuranceApiStack --require-approval never
```

Note: AI agents run on Bedrock AgentCore Runtimes (ECR-based ARM64 containers), not Lambda. The API handlers (claims, documents, metrics, chat) use Lambda.

---

### Issue: Frontend Shows CORS Error

**Error**: `Access blocked by CORS policy`

**Solution**:
1. Check API Gateway CORS settings in AWS Console
2. Verify frontend URL is in allowed origins
3. Redeploy API stack:
```bash
cd backend/infrastructure
cdk deploy LifeInsuranceApiStack --require-approval never
```

---

### Issue: Knowledge Base Stack Fails with 404 Error

**Error**: `Failed to create index policy-guidelines-index: 404`

**Root Cause**: OpenSearch Serverless has a known race condition where the collection reports as created but isn't fully ready to accept index creation requests. Even with 180-second waits and retry logic, the timing is unpredictable.

**RECOMMENDED SOLUTION - Deploy Without Custom Resource**:

The most reliable approach is to remove the automated index creation and create indices manually after the collection is fully ready.

**Option A: Remove Custom Resource (Recommended)**

1. **Comment out the custom resource** in `backend/infrastructure/lib/knowledge-base-stack.ts`:

Find these lines (around line 110-140) and comment them out:
```typescript
// Custom resource Lambda to create OpenSearch indices
// const indexCreatorRole = new iam.Role(this, 'IndexCreatorRole', {
//   ... (comment out entire custom resource section)
// });

// const indexCreator = new cdk.CustomResource(this, 'OpenSearchIndices', {
//   ... (comment out)
// });
```

Also comment out the dependency lines in the Knowledge Base resources:
```typescript
// policyKB.node.addDependency(indexCreator);
// fraudKB.node.addDependency(indexCreator);
// regulatoryKB.node.addDependency(indexCreator);
```

2. **Deploy the Infra stack** (will create collection but not indices):
```bash
cd backend/infrastructure
cdk deploy LifeInsuranceInfraStack --require-approval never
```

3. **Wait for collection to be ACTIVE** (check every 2 minutes):
```bash
aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].[name,status]' \
  --output table

# Keep checking until status shows: ACTIVE
# This can take 10-15 minutes after stack deployment
```

4. **Create indices manually** (save as `backend/infrastructure/create_indices.py`):
```python
import boto3
import json
import time
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import requests
import sys

def create_index(endpoint, index_name):
    session = boto3.Session()
    credentials = session.get_credentials()
    region = session.region_name or 'us-east-1'
    
    url = f"https://{endpoint}/{index_name}"
    
    index_body = {
        "settings": {"index": {"knn": True, "knn.algo_param.ef_search": 512}},
        "mappings": {
            "properties": {
                "vector": {
                    "type": "knn_vector",
                    "dimension": 1024,
                    "method": {
                        "name": "hnsw",
                        "engine": "faiss",
                        "parameters": {"ef_construction": 512, "m": 16}
                    }
                },
                "text": {"type": "text"},
                "metadata": {"type": "text"}
            }
        }
    }
    
    request = AWSRequest(
        method='PUT', url=url, data=json.dumps(index_body),
        headers={'Content-Type': 'application/json'}
    )
    SigV4Auth(credentials, 'aoss', region).add_auth(request)
    
    response = requests.put(url, data=json.dumps(index_body), headers=dict(request.headers))
    
    if response.status_code in [200, 201]:
        print(f"✓ Created index: {index_name}")
        return True
    elif 'resource_already_exists' in response.text:
        print(f"✓ Index already exists: {index_name}")
        return True
    else:
        print(f"✗ Failed: {response.status_code} {response.text}")
        return False

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 create_indices.py <opensearch-endpoint>")
        sys.exit(1)
    
    endpoint = sys.argv[1].replace('https://', '')
    indices = ['policy-guidelines-index', 'fraud-patterns-index', 'regulatory-index']
    
    print(f"Creating indices on endpoint: {endpoint}\n")
    
    success_count = 0
    for index in indices:
        if create_index(endpoint, index):
            success_count += 1
        time.sleep(2)
    
    print(f"\n✓ Successfully created {success_count}/{len(indices)} indices!")
    sys.exit(0 if success_count == len(indices) else 1)
```

5. **Run the script**:
```bash
# Get endpoint from stack outputs
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name LifeInsuranceInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`OpenSearchEndpoint`].OutputValue' \
  --output text)

# Install requests library
pip3 install requests

# Create indices
python3 create_indices.py $ENDPOINT
```

6. **Redeploy Infra stack** (now indices exist, Knowledge Bases will connect):
```bash
cdk deploy LifeInsuranceInfraStack --require-approval never
```

**Option B: Increase Wait Time (Less Reliable)**

If you want to keep the automated approach, try increasing the wait time:

1. Edit `backend/infrastructure/lib/knowledge-base-stack.ts`:
```typescript
properties: {
  CollectionEndpoint: collection.attrCollectionEndpoint,
  Indices: JSON.stringify([...]),
  WaitSeconds: 300, // Increase from 180 to 300 (5 minutes)
},
```

2. Edit `backend/infrastructure/lib/opensearch-index-handler.py`:
```python
def create_index_with_retry(endpoint, index_name, max_retries=8):  # Increase retries
    for attempt in range(max_retries):
        try:
            create_index(endpoint, index_name)
            return
        except Exception as e:
            if '404' in str(e) and attempt < max_retries - 1:
                wait_time = 60 * (attempt + 1)  # Longer backoff: 60s, 120s, 180s...
                print(f"Attempt {attempt + 1} failed, waiting {wait_time}s...")
                time.sleep(wait_time)
```

3. Redeploy:
```bash
cdk deploy LifeInsuranceInfraStack --require-approval never
```

**Note**: Option A (manual indices) is more reliable because OpenSearch Serverless timing is unpredictable.

---

**Error**: `Failed to start ingestion job`

**Solution**:
```bash
# Check if data was uploaded
aws s3 ls s3://life-insurance-kb-{account}-{region}/policy-guidelines/

# If empty, reload data
cd backend/knowledge-bases
python3 load_knowledge_bases.py
python3 sync_knowledge_bases.py
```

---

### Issue: Claims Not Processing

**Symptoms**: Claim stuck in "Submitted" status

**Solution**:
```bash
# Check AgentCore Runtime logs
aws logs tail /aws/bedrock-agentcore/supervisor --follow

# Check API Lambda logs
aws logs tail /aws/lambda/LifeInsuranceClaims-ClaimsHandler --follow

# Verify AgentCore Runtimes are running
aws bedrock-agentcore list-agent-runtimes
```

---

### Debugging Commands

```bash
# List all CloudFormation stacks
aws cloudformation list-stacks

# Describe specific stack
aws cloudformation describe-stacks --stack-name LifeInsuranceInfraStack

# List Lambda functions
aws lambda list-functions | grep LifeInsurance

# Tail Lambda logs
aws logs tail /aws/lambda/{function-name} --follow

# List DynamoDB tables
aws dynamodb list-tables

# List S3 buckets
aws s3 ls | grep life-insurance

# Check Cognito user pool
aws cognito-idp list-user-pools --max-results 10
```

---

## Cleanup

When you're done with the demo and want to remove all resources:

```bash
# Navigate to infrastructure directory
cd backend/infrastructure

# Empty S3 buckets first (CDK can't delete non-empty buckets)
DOCS_BUCKET=$(cat outputs.json | jq -r '.LifeInsuranceInfraStack.DocumentsBucketName')
FRONTEND_BUCKET=$(cat outputs.json | jq -r '.LifeInsuranceInfraStack.FrontendBucketName')

aws s3 rm s3://$DOCS_BUCKET --recursive
aws s3 rm s3://$FRONTEND_BUCKET --recursive

# Destroy all stacks
cdk destroy --all --force

# Clean up local files
rm -f outputs.json
rm -rf cdk.out
```

---

## Cost Tracking

### Expected Monthly Costs (Development)

| Service | Cost | Notes |
|---------|------|-------|
| OpenSearch Serverless | $100-200 | Fixed cost (OCU-based) |
| Bedrock API Calls | $30-50 | 100 claims × $0.30-0.50 |
| Lambda | $10-20 | 100 claims × 6 agents |
| DynamoDB | $5-10 | On-demand, low volume |
| S3 | $5 | Storage + requests |
| API Gateway | $5-10 | 1000 requests |
| CloudWatch | $5-10 | Logs + metrics |
| **Total** | **$160-305** | |

### Monitor Costs

```bash
# Check current month costs
aws ce get-cost-and-usage \
  --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=SERVICE
```

---

## Deployment Checklist

Use this to track your progress:

### Pre-Deployment
- [ ] Node.js 18+ installed
- [ ] Python 3.11+ installed
- [ ] AWS CLI configured
- [ ] AWS CDK installed
- [ ] AWS credentials verified
- [ ] Bedrock models enabled

### Phase 1: Infrastructure
- [ ] npm install completed
- [ ] CDK bootstrapped
- [ ] Infrastructure stack deployed
- [ ] Knowledge base stack deployed
- [ ] Agent stack deployed
- [ ] API stack deployed
- [ ] Monitoring stack deployed
- [ ] Outputs saved to outputs.json

### Phase 2: Knowledge Bases
- [ ] Python dependencies installed
- [ ] Knowledge base data uploaded
- [ ] Ingestion jobs started

### Phase 3: Agents (via CDK)
- [ ] Agent stack deployed (Phase 1)
- [ ] All 6 AgentCore Runtimes visible in console

### Phase 4: Frontend
- [ ] npm dependencies installed
- [ ] .env file created
- [ ] Production build completed
- [ ] Deployed to S3
- [ ] Frontend URL accessible

### Phase 5: Test Data
- [ ] Test scenarios loaded
- [ ] Test users created

### Verification
- [ ] All stacks show CREATE_COMPLETE
- [ ] Frontend loads in browser
- [ ] Can login with test users
- [ ] Can submit claims
- [ ] Claims process successfully
- [ ] Dashboard shows metrics

---

## Version History

### Version 2.1.0 (March 9, 2026)
- **Security**: Removed all references to specific AWS account ID, resource IDs, and deployment-specific endpoints
- **Changed**: `scripts/deploy.sh` now dynamically resolves account ID via `aws sts get-caller-identity`
- **Updated**: `frontend/.env.example` corrected to use actual env var names (`VITE_USER_POOL_ID`, `VITE_USER_POOL_CLIENT_ID`)
- **Added**: `.gitignore` for `outputs.json`, `cdk.out/`, `frontend/dist/`, `frontend/.env`, `.DS_Store`, `*_package/`
- **Added**: "What You Need to Provide vs What's Auto-Generated" section in pre-deployment checklist
- **Removed**: `backend/infrastructure/outputs.json`, `backend/infrastructure/cdk.out/`, `frontend/dist/`, stale diagram files, `.DS_Store` files
- **Updated**: Consistent author, version, and date metadata across all documentation

### Version 2.0.0 (March 6, 2026)
- **Added**: AI Claims Assistant chatbot — floating chat widget for claimants powered by Claude Sonnet 4 with FAQ knowledge about claims process, required documents, and timelines
- **Added**: Chat Lambda (`LifeInsuranceChatHandler`) and `/chat` POST API route with Cognito auth
- **Changed**: AI Processing Flow sidebar moved from Claimant ClaimDetails page to Adjuster Workbench — adjusters now see the 8-step multi-agent pipeline visualization when reviewing claims
- **Added**: Auto-polling in Adjuster Workbench while claims are processing (live step progression)
- **Added**: Document verification in AI processing — Lambda fetches uploaded documents from S3 and includes text content in the AI prompt
- **Changed**: ChatWidget auto-opens after 1.5 seconds for claimants (empathetic greeting for grieving users)
- **Changed**: ChatWidget only visible to Claimant role (not adjusters or business users)
- **Added**: Status badges in Adjuster claims queue (escalated/approved/denied/submitted)
- **Added**: Approve/Deny buttons only shown for actionable claim statuses in Adjuster Workbench

### Version 1.1.0 (March 6, 2026)
- **Fixed**: Business Dashboard now shows real metrics from DynamoDB (was showing zeros for all stats except total claims)
- **Fixed**: Frontend field name mismatches (`metrics.approved` → `metrics.approvedClaims`, etc.)
- **Added**: Claims Overview table in Business Dashboard showing all claims with status, amount, and AI decision summary
- **Added**: Status Distribution bar (color-coded proportional view of approved/denied/escalated/pending)
- **Added**: STP Rate, AI Agent Invocations, and Fraud Detected metrics computed from actual claim data
- **Fixed**: AdjusterWorkbench now shows escalated claims (was filtering only `submitted` status)
- **Added**: Full claim details in Adjuster detail panel (policy number, beneficiary, relationship, date/cause of death)
- **Added**: Demo Quick-Fill dropdown on Submit Claim page with all 7 test scenarios
- **Changed**: AI model upgraded from Claude 3.5 Sonnet to Claude Sonnet 4 (`us.anthropic.claude-sonnet-4-20250514-v1:0`)
- **Fixed**: Claims Lambda CORS headers, Decimal serialization, DynamoDB composite key queries
- **Fixed**: Login "Signing in..." stuck state, added `checkAuth()` on startup
- **Added**: Role-based access control with `RoleGuard` component
- **Architecture**: Claim processing uses EventBridge-triggered Lambda → AgentCore Supervisor (6-agent pipeline) as the primary path. Direct Bedrock InvokeModel is retained only as a fallback if AgentCore is unavailable

### Version 1.0.12 (March 5, 2026)
- **Changed**: Agent stack rewritten from ECR/CodeBuild container approach to Direct Code Deploy (S3-based)
- **Removed**: All ECR repositories, CodeBuild projects, trigger Lambda, and custom resources from agent stack
- **Added**: S3 code assets with `S3CodeConfiguration` in `AgentRuntimeArtifact` for all 6 agents
- **Added**: Per-agent `requirements.txt` files in each agent source directory
- **Benefit**: ~18 fewer AWS resources, faster deploys, no Docker builds, simpler demo footprint
- **Note**: AgentCore handles containerization automatically from the uploaded Python source code

### Version 1.0.11 (March 5, 2026)
- **Updated**: Comprehensive lessons learned documented in DEPLOYMENT ARTIFACTS/03_TROUBLESHOOTING.md (v2.0.0)
- **Added**: 12 lessons learned covering CDK paths, OpenSearch race conditions, SigV4 signing, orphaned resources
- **Fixed**: Bedrock KB role added to OpenSearch data access policy (Lesson 11)
- **Fixed**: Added 3-minute propagation delay custom resource before KB creation (Lesson 12)
- **Updated**: create_indices.py rewritten to use opensearch-py with auto-polling for collection status
- **Updated**: Pre-deployment checklist and deployment steps with parallel index creation approach
- **Added**: Python prerequisites (opensearch-py, requests-aws4auth) to pre-deployment requirements
- **Status**: KB stack deploys successfully with all fixes applied

### Version 1.0.10 (March 5, 2026)
- **Updated**: Increased wait times for Option B (automated approach)
- **Lambda timeout**: Increased from 5 to 15 minutes to accommodate longer waits
- **Fixed**: Added explicit CDK dependencies on dataAccessPolicy and networkPolicy for custom resource
- **Fixed**: Lambda handler SigV4 signing (use get_frozen_credentials, preserve signed headers)

### Version 1.0.9 (March 5, 2026)
- **Updated**: Knowledge Base troubleshooting section with recommended manual approach
- **Added**: Standalone `create_indices.py` script for manual index creation
- **Reason**: OpenSearch Serverless has unpredictable timing - manual approach is more reliable
- **Recommendation**: Remove custom resource, deploy stack, wait for ACTIVE, create indices manually, redeploy

### Version 1.0.8 (March 5, 2026)
- **Updated**: All documentation now reflects CloudFront usage
- **Files Updated**: ARCHITECTURE.md, END_TO_END_CLAIMS_PROCESS.md, CLAIMS_PROCESS_QUICK_REFERENCE.md
- **Complete**: All references to public S3 website hosting replaced with CloudFront CDN

### Version 1.0.7 (March 5, 2026)
- **Changed**: Frontend now uses CloudFront distribution instead of public S3 bucket
- **Security**: Frontend bucket is now private with CloudFront Origin Access Identity
- **Added**: CloudFront invalidation step in frontend deployment
- **Benefit**: Works with S3 Block Public Access enabled at account level

### Version 1.0.6 (March 5, 2026)
- **Success**: CDK synth now works successfully
- **Note**: Deprecation warnings are normal and won't affect deployment
- **Ready**: All stacks ready for deployment

### Version 1.0.5 (March 5, 2026)
- **Added**: Created missing Lambda handler files (claims_handler.py, documents_handler.py, metrics_handler.py)
- **Note**: These are placeholder implementations that will be enhanced during deployment

### Version 1.0.4 (March 5, 2026)
- **Fixed**: Corrected Lambda handler paths in api-stack.ts (changed from `../../lambda/` to `../lambda/`)
- **Note**: All asset paths in CDK stacks now use correct relative paths from infrastructure directory

### Version 1.0.3 (March 5, 2026)
- **Fixed**: Removed `AWS_REGION` from Lambda environment variables (reserved by Lambda runtime)
- **Note**: Lambda functions can access region via `process.env.AWS_REGION` automatically

### Version 1.0.2 (March 5, 2026)
- **Fixed**: Corrected asset paths in agent-stack.ts (changed from `../../agents/` to `../agents/`)
- **Issue**: CDK was looking for files in wrong location due to incorrect relative paths

### Version 1.0.1 (March 5, 2026)
- **Fixed**: Corrected deployment order - Lambda layer must be created BEFORE deploying Agent stack
- **Updated**: Phase 1 now includes layer creation as Step 1.1
- **Updated**: Phase 3 simplified since layer already exists

### Version 1.0.0 (March 5, 2026)
- Initial deployment guide
- Manual deployment steps for all phases
- Troubleshooting section
- Cleanup instructions
- Cost tracking

---

## Quick Reference

### Test Users

| Username | Password | Role |
|----------|----------|------|
| claimant1 | Test123!Pass | Claimant |
| adjuster1 | Test123!Pass | Adjuster |
| business1 | Test123!Pass | Business |

### Stack Names

- `LifeInsuranceInfraStack` - Core infrastructure (S3, DynamoDB, Cognito, CloudFront, OpenSearch, KBs, Guardrail)
- `LifeInsuranceAgentStack` - AI agents (ECR, CodeBuild, 6 AgentCore Runtimes)
- `LifeInsuranceApiStack` - API Gateway, Lambda functions, CloudWatch monitoring

### Key Resources

- **Frontend**: CloudFront distribution with private S3 bucket
- **API**: API Gateway REST API
- **Agents**: 6 Bedrock AgentCore Runtimes (ECR-based ARM64 containers)
- **Data**: 2 DynamoDB tables (claims, metrics)
- **Documents**: S3 bucket
- **Auth**: Cognito user pool
- **Search**: OpenSearch Serverless (3 vector indices)
- **AI**: 3 Bedrock Knowledge Bases + 1 Guardrail
- **Build**: CodeBuild project (ARM64 Docker image builds)
- **Registry**: 6 ECR repositories

---

**End of Deployment Guide**

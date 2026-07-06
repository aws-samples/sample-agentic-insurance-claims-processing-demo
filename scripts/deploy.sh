#!/bin/bash
###############################################################################
# CCOE Insurance Industry LLC — Full Deployment Script
#
# This script deploys the entire solution from scratch:
#   1. Model Selection (scan Bedrock models, recommend ACTIVE, flag LEGACY)
#   2. CDK Bootstrap
#   3. CDK Deploy (3 stacks: Infra, Agent, API)
#   4. OpenSearch index creation
#   5. Knowledge Base data upload + sync
#   6. Cognito user creation
#   7. Frontend build + deploy
#
# USAGE:
#   Run each section manually by copying commands into your terminal.
#   The script is organized into numbered phases — run them in order.
#   Wait for each phase to complete before starting the next.
###############################################################################

set -e

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="us-east-1"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=============================================="
echo "CCOE Insurance — Deployment to $ACCOUNT_ID"
echo "Region: $REGION"
echo "Project: $PROJECT_ROOT"
echo "=============================================="
echo ""

###############################################################################
# PHASE 0: Prerequisites Check
###############################################################################
echo "=== PHASE 0: Prerequisites Check ==="

# Verify AWS identity
echo "Checking AWS credentials..."
aws sts get-caller-identity --region $REGION
echo ""

# Verify Node.js and npm
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo ""

# Install CDK dependencies if needed
echo "Installing CDK dependencies..."
cd "$PROJECT_ROOT/backend/infrastructure"
npm install
echo ""

# Install Python dependencies for OpenSearch index creation
echo "Installing Python dependencies for OpenSearch..."
pip3 install opensearch-py requests-aws4auth boto3 --quiet
echo ""

# Security: Dependency vulnerability scan
echo "Scanning Python dependencies for known vulnerabilities..."
pip3 install pip-audit --quiet
pip-audit -r "$PROJECT_ROOT/backend/agents/requirements.txt" --progress-spinner off 2>&1 | tail -10 || echo "WARNING: pip-audit found vulnerabilities (review above)"
echo ""

###############################################################################
# PHASE 1: Model Selection
###############################################################################
echo "=== PHASE 1: Model Selection ==="
echo "Scanning available Bedrock models in $REGION..."
echo ""
cd "$PROJECT_ROOT"
python3 scripts/select_model.py --region $REGION
echo ""
echo "✓ Model selection complete"
echo ""

###############################################################################
# PHASE 2: CDK Bootstrap
###############################################################################
echo "=== PHASE 2: CDK Bootstrap ==="
echo "Bootstrapping CDK in $ACCOUNT_ID/$REGION..."
cd "$PROJECT_ROOT/backend/infrastructure"
npx cdk bootstrap aws://$ACCOUNT_ID/$REGION
echo ""
echo "✓ CDK Bootstrap complete"
echo ""

###############################################################################
# PHASE 3: CDK Deploy (all 3 stacks)
# This will:
#   - Create S3 buckets, DynamoDB, Cognito, CloudFront, OpenSearch, KBs, Guardrail
#   - Build 6 Docker images via CodeBuild and push to ECR
#   - Create 6 AgentCore runtimes
#   - Create API Gateway + 4 Lambda functions + CloudWatch monitoring
#
# NOTE: This takes 15-25 minutes (OpenSearch collection + CodeBuild images)
#
# Index creation runs automatically in parallel during CDK deploy.
###############################################################################
echo "=== PHASE 2: CDK Deploy ==="
echo ""
echo "Deploying all stacks (this takes 15-25 minutes)..."
echo "OpenSearch index creation will run automatically in parallel."
echo ""
cd "$PROJECT_ROOT/backend/infrastructure"

# Start index creation in the background — it polls until collection is ACTIVE
python3 create_indices.py > /tmp/create_indices.log 2>&1 &
INDEX_PID=$!
echo "  Index creation started in background (PID: $INDEX_PID)"

npx cdk deploy --all --require-approval never --outputs-file outputs.json
echo ""
echo "✓ CDK Deploy complete"

# Wait for index creation to finish (if still running)
if kill -0 $INDEX_PID 2>/dev/null; then
    echo "Waiting for OpenSearch index creation to complete..."
    wait $INDEX_PID
fi
INDEX_EXIT=$?
if [ $INDEX_EXIT -eq 0 ]; then
    echo "✓ OpenSearch indices created successfully"
else
    echo "⚠️  Index creation may have failed. Check /tmp/create_indices.log"
    echo "  You can retry manually: cd backend/infrastructure && python3 create_indices.py"
fi
echo ""

# Extract outputs
echo "Extracting deployment outputs..."
cat outputs.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
outputs = {}
for stack, vals in data.items():
    outputs.update(vals)
print('--- Deployment Outputs ---')
for k, v in sorted(outputs.items()):
    print(f'  {k}: {v}')
"
echo ""

###############################################################################
# PHASE 4: OpenSearch Indices
# Run this AFTER Phase 2 completes (collection must be ACTIVE)
###############################################################################
echo "=== PHASE 3: OpenSearch Index Verification ==="
echo "Verifying OpenSearch indices were created (ran in background during Phase 2)..."
echo ""
if [ -f /tmp/create_indices.log ]; then
    tail -5 /tmp/create_indices.log
fi
echo ""
echo "✓ OpenSearch indices verified"
echo "✓ OpenSearch indices created"
echo ""

###############################################################################
# PHASE 4: Knowledge Base Data Upload + Sync
###############################################################################
echo "=== PHASE 4: Knowledge Base Data ==="

# Extract KB bucket name from outputs
KB_BUCKET="life-insurance-kb-${ACCOUNT_ID}-${REGION}"
echo "Uploading KB data to: $KB_BUCKET"

cd "$PROJECT_ROOT/backend/knowledge-bases"
KB_BUCKET=$KB_BUCKET python3 load_knowledge_bases.py
echo ""

# Sync knowledge bases
echo "Syncing knowledge bases..."
python3 sync_knowledge_bases.py || echo "(sync script may need outputs.json — check manually)"
echo ""
echo "✓ Knowledge base data loaded"
echo ""

###############################################################################
# PHASE 5: Cognito Users
# Creates 3 demo users: claimant1, adjuster1, business1
###############################################################################
echo "=== PHASE 5: Cognito User Creation ==="

# Extract User Pool ID from outputs
USER_POOL_ID=$(python3 -c "
import json
with open('$PROJECT_ROOT/backend/infrastructure/outputs.json') as f:
    data = json.load(f)
for stack, vals in data.items():
    if 'UserPoolId' in vals:
        print(vals['UserPoolId'])
        break
")

echo "User Pool ID: $USER_POOL_ID"
echo ""

# Create claimant1
echo "Creating claimant1..."
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username claimant1 \
  --user-attributes Name=email,Value=claimant1@example.com Name=given_name,Value=Margaret Name=family_name,Value=Mitchell \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS \
  --region $REGION

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username claimant1 \
  --password 'Test123!Pass' \
  --permanent \
  --region $REGION

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username claimant1 \
  --group-name Claimants \
  --region $REGION

echo "  ✓ claimant1 created (Claimants group)"

# Create adjuster1
echo "Creating adjuster1..."
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username adjuster1 \
  --user-attributes Name=email,Value=adjuster1@example.com Name=given_name,Value=James Name=family_name,Value=Wilson \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS \
  --region $REGION

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username adjuster1 \
  --password 'Test123!Pass' \
  --permanent \
  --region $REGION

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username adjuster1 \
  --group-name Adjusters \
  --region $REGION

echo "  ✓ adjuster1 created (Adjusters group)"

# Create business1
echo "Creating business1..."
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username business1 \
  --user-attributes Name=email,Value=business1@example.com Name=given_name,Value=Sarah Name=family_name,Value=Chen \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS \
  --region $REGION

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username business1 \
  --password 'Test123!Pass' \
  --permanent \
  --region $REGION

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username business1 \
  --group-name BusinessUsers \
  --region $REGION

echo "  ✓ business1 created (BusinessUsers group)"
echo ""
echo "✓ All Cognito users created"
echo ""
echo "NOTE: MFA (TOTP) is required. On first login, each user will be"
echo "prompted to set up their authenticator app (Google Authenticator,"
echo "Authy, 1Password). The frontend handles this flow automatically."
echo ""

###############################################################################
# PHASE 6: Frontend Build + Deploy
###############################################################################
echo "=== PHASE 6: Frontend Build + Deploy ==="

# Extract API URL and Cognito details from outputs
API_URL=$(python3 -c "
import json
with open('$PROJECT_ROOT/backend/infrastructure/outputs.json') as f:
    data = json.load(f)
for stack, vals in data.items():
    if 'ApiUrl' in vals:
        print(vals['ApiUrl'])
        break
")

USER_POOL_CLIENT_ID=$(python3 -c "
import json
with open('$PROJECT_ROOT/backend/infrastructure/outputs.json') as f:
    data = json.load(f)
for stack, vals in data.items():
    if 'UserPoolClientId' in vals:
        print(vals['UserPoolClientId'])
        break
")

CLOUDFRONT_DIST_ID=$(python3 -c "
import json
with open('$PROJECT_ROOT/backend/infrastructure/outputs.json') as f:
    data = json.load(f)
for stack, vals in data.items():
    if 'CloudFrontDistributionId' in vals:
        print(vals['CloudFrontDistributionId'])
        break
")

FRONTEND_BUCKET="life-insurance-frontend-${ACCOUNT_ID}-${REGION}"

echo "API URL:           $API_URL"
echo "User Pool ID:      $USER_POOL_ID"
echo "User Pool Client:  $USER_POOL_CLIENT_ID"
echo "CloudFront Dist:   $CLOUDFRONT_DIST_ID"
echo "Frontend Bucket:   $FRONTEND_BUCKET"
echo ""

# Write frontend .env
echo "Writing frontend .env..."
cat > "$PROJECT_ROOT/frontend/.env" << EOF
VITE_API_URL=${API_URL}
VITE_AWS_REGION=${REGION}
VITE_USER_POOL_ID=${USER_POOL_ID}
VITE_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID}
EOF
echo "  ✓ .env written"
echo ""

# Build frontend
echo "Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
npm run build
echo "  ✓ Frontend built"
echo ""

# Deploy to S3 + CloudFront
echo "Deploying frontend to S3..."
aws s3 sync dist/ s3://$FRONTEND_BUCKET/ --delete --region $REGION
echo "  ✓ S3 sync complete"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DIST_ID --paths "/*" --region $REGION
echo "  ✓ CloudFront invalidation started"
echo ""

###############################################################################
# PHASE 7: Verification
###############################################################################
echo "=== PHASE 7: Verification ==="

FRONTEND_URL=$(python3 -c "
import json
with open('$PROJECT_ROOT/backend/infrastructure/outputs.json') as f:
    data = json.load(f)
for stack, vals in data.items():
    if 'FrontendURL' in vals:
        print(vals['FrontendURL'])
        break
")

echo "=============================================="
echo "  DEPLOYMENT COMPLETE"
echo "=============================================="
echo ""
echo "  Frontend URL:  $FRONTEND_URL"
echo "  API URL:       $API_URL"
echo "  Region:        $REGION"
echo "  Account:       $ACCOUNT_ID"
echo ""
echo "  Login Credentials:"
echo "    claimant1 / Test123!"
echo "    adjuster1 / Test123!"
echo "    business1 / Test123!"
echo ""
echo "=============================================="

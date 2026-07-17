#!/bin/bash

# Deploy Frontend Script for CCOE Insurance Industry LLC
# This script builds and deploys the React frontend

set -e  # Exit on error

echo "=========================================="
echo "CCOE Insurance Industry LLC"
echo "Frontend Deployment"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
print_status "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    print_error "npm is not installed"
    exit 1
fi

if ! command -v aws &> /dev/null; then
    print_error "AWS CLI is not installed"
    exit 1
fi

print_success "Prerequisites met"
echo ""

# Navigate to frontend directory
cd "$(dirname "$0")/../frontend"

# Step 1: Install dependencies
print_status "Step 1/5: Installing npm dependencies..."
npm install
print_success "Dependencies installed"
echo ""

# Step 2: Get stack outputs
print_status "Step 2/5: Reading CDK stack outputs..."
OUTPUTS_FILE="../backend/infrastructure/outputs.json"

if [ ! -f "$OUTPUTS_FILE" ]; then
    print_error "outputs.json not found. Please deploy infrastructure first."
    exit 1
fi

API_URL=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceApiStack.ApiUrl // empty')
USER_POOL_ID=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.UserPoolId // empty')
USER_POOL_CLIENT_ID=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.UserPoolClientId // empty')
FRONTEND_BUCKET=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.FrontendBucketName // empty')
AWS_REGION=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.Region // "us-east-1"')

if [ -z "$API_URL" ] || [ -z "$USER_POOL_ID" ] || [ -z "$USER_POOL_CLIENT_ID" ] || [ -z "$FRONTEND_BUCKET" ]; then
    print_error "Missing required outputs from CDK deployment"
    exit 1
fi

print_success "Stack outputs loaded"
echo ""

# Step 3: Create .env file
print_status "Step 3/5: Creating .env file..."
cat > .env << EOF
VITE_API_URL=$API_URL
VITE_AWS_REGION=$AWS_REGION
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
EOF
print_success ".env file created"
echo ""

# Step 4: Build frontend
print_status "Step 4/5: Building production bundle..."
npm run build
print_success "Frontend built"
echo ""

# Step 5: Deploy to S3
print_status "Step 5/5: Deploying to S3..."
aws s3 sync dist/ s3://$FRONTEND_BUCKET --delete
print_success "Frontend deployed to S3"
echo ""

# Get frontend URL
FRONTEND_URL=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.FrontendURL // empty')

echo "=========================================="
echo "Frontend Deployment Complete!"
echo "=========================================="
echo ""
print_success "Frontend is now live!"
echo ""
echo "Frontend URL: $FRONTEND_URL"
echo ""
echo "Test Users:"
echo "  Claimant: claimant1 / Test123!"
echo "  Adjuster: adjuster1 / Test123!"
echo "  Business: business1 / Test123!"
echo ""
echo "Next steps:"
echo "1. Load test data: cd ../test-data && python3 load_test_scenarios.py"
echo "2. Create test users: python3 create_test_users.py"
echo "3. Open frontend URL in browser"
echo ""

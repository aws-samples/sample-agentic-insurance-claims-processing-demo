#!/bin/bash

# Cleanup Script for CCOE Insurance Industry LLC
# This script removes all deployed resources
# Updated for 3-stack consolidated architecture

set -e

echo "=========================================="
echo "CCOE Insurance Industry LLC"
echo "Resource Cleanup"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

print_warning "This will DELETE all deployed resources including:"
echo "  - All 3 CDK stacks (Infra, Agent, API)"
echo "  - S3 buckets and their contents"
echo "  - DynamoDB tables and data"
echo "  - ECR repositories and images"
echo "  - Lambda functions"
echo "  - Cognito user pool and users"
echo "  - Knowledge bases and OpenSearch collection"
echo "  - AgentCore runtimes"
echo "  - CloudWatch logs and dashboards"
echo ""
print_error "THIS ACTION CANNOT BE UNDONE!"
echo ""

read -p "Are you sure you want to delete everything? (type 'DELETE' to confirm): " CONFIRM
if [ "$CONFIRM" != "DELETE" ]; then
    echo "Cleanup cancelled"
    exit 0
fi
echo ""

cd "$(dirname "$0")/../backend/infrastructure"

# Empty S3 buckets first
print_status "Emptying S3 buckets..."

OUTPUTS_FILE="outputs.json"
if [ -f "$OUTPUTS_FILE" ]; then
    DOCS_BUCKET=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.DocumentsBucketName // empty')
    FRONTEND_BUCKET=$(cat $OUTPUTS_FILE | jq -r '.LifeInsuranceInfraStack.FrontendBucketName // empty')

    if [ -n "$DOCS_BUCKET" ]; then
        print_status "Emptying documents bucket: $DOCS_BUCKET"
        aws s3 rm s3://$DOCS_BUCKET --recursive || true
    fi

    if [ -n "$FRONTEND_BUCKET" ]; then
        print_status "Emptying frontend bucket: $FRONTEND_BUCKET"
        aws s3 rm s3://$FRONTEND_BUCKET --recursive || true
    fi
fi

print_success "S3 buckets emptied"
echo ""

# Destroy stacks in reverse dependency order
print_status "Destroying CDK stacks..."
echo ""

print_status "Destroying API Stack..."
cdk destroy LifeInsuranceApiStack --force || print_warning "API stack not found or already deleted"

print_status "Destroying Agent Stack..."
cdk destroy LifeInsuranceAgentStack --force || print_warning "Agent stack not found or already deleted"

print_status "Destroying Infrastructure Stack..."
cdk destroy LifeInsuranceInfraStack --force || print_warning "Infra stack not found or already deleted"

print_success "All stacks destroyed"
echo ""

# Clean up local files
print_status "Cleaning up local files..."
rm -f outputs.json
rm -f outputs-*.json
rm -rf cdk.out
print_success "Local files cleaned"
echo ""

echo "=========================================="
echo "Cleanup Complete!"
echo "=========================================="
echo ""
print_success "All resources have been deleted"
echo ""
echo "To redeploy the system, run:"
echo "  bash scripts/deploy.sh"
echo ""

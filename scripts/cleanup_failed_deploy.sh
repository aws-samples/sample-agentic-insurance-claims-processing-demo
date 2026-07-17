#!/bin/bash
###############################################################################
# Cleanup script for failed deployments
# Run this if CDK deploy fails and you need to start over.
# Based on Lessons 4 and 9 from the troubleshooting guide.
###############################################################################

REGION="us-east-1"

echo "=== Cleaning up failed deployment ==="
echo ""

# Delete CDK stacks (reverse order)
echo "Deleting CDK stacks..."
for STACK in LifeInsuranceApiStack LifeInsuranceAgentStack LifeInsuranceInfraStack; do
  STATUS=$(aws cloudformation describe-stacks --stack-name $STACK --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
  if [ -n "$STATUS" ]; then
    echo "  Deleting $STACK (status: $STATUS)..."
    aws cloudformation delete-stack --stack-name $STACK --region $REGION
    aws cloudformation wait stack-delete-complete --stack-name $STACK --region $REGION 2>/dev/null
    echo "  ✓ $STACK deleted"
  else
    echo "  $STACK not found, skipping"
  fi
done
echo ""

# Clean up orphaned OpenSearch resources (Lesson 9)
echo "Cleaning up orphaned OpenSearch resources..."
aws opensearchserverless delete-security-policy --name life-insurance-kb-network --type network --region $REGION 2>/dev/null && echo "  ✓ Deleted network policy" || echo "  (no network policy)"
aws opensearchserverless delete-security-policy --name life-insurance-kb-encryption --type encryption --region $REGION 2>/dev/null && echo "  ✓ Deleted encryption policy" || echo "  (no encryption policy)"
aws opensearchserverless delete-access-policy --name life-insurance-kb-access --type data --region $REGION 2>/dev/null && echo "  ✓ Deleted access policy" || echo "  (no access policy)"

COLLECTION_ID=$(aws opensearchserverless list-collections --region $REGION --query 'collectionSummaries[?name==`life-insurance-kb`].id' --output text 2>/dev/null)
if [ -n "$COLLECTION_ID" ] && [ "$COLLECTION_ID" != "None" ]; then
  echo "  Deleting collection $COLLECTION_ID..."
  aws opensearchserverless delete-collection --id $COLLECTION_ID --region $REGION
  echo "  ✓ Collection deletion initiated"
else
  echo "  (no collection found)"
fi
echo ""

# Check for CDKToolkit issues (Lesson 4)
CDK_STATUS=$(aws cloudformation describe-stacks --stack-name CDKToolkit --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
if [ "$CDK_STATUS" = "UPDATE_ROLLBACK_FAILED" ] || [ "$CDK_STATUS" = "ROLLBACK_FAILED" ]; then
  echo "⚠️  CDKToolkit stack is in $CDK_STATUS state."
  echo "  Deleting CDKToolkit stack..."
  aws cloudformation delete-stack --stack-name CDKToolkit --region $REGION
  aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region $REGION
  echo "  ✓ CDKToolkit deleted. Re-run: npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1"
fi

echo ""
echo "Waiting 60s for resources to fully clean up..."
sleep 60

echo ""
echo "=== Cleanup complete ==="
echo "Verify clean state:"
echo "  aws cloudformation list-stacks --query \"StackSummaries[?contains(StackName,'LifeInsurance')].{Name:StackName,Status:StackStatus}\" --region $REGION"
echo "  aws opensearchserverless list-collections --region $REGION"
echo ""
echo "You can now re-run: bash scripts/deploy.sh"

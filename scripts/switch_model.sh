#!/bin/bash
###############################################################################
# Switch AI Model — Update deployed Lambdas with a new Bedrock model
#
# Use this script AFTER initial deployment to change the AI model.
# It runs the model selection tool and updates all Lambda functions
# with the new model ID without requiring a full CDK redeploy.
#
# Usage:
#   bash scripts/switch_model.sh [--non-interactive] [--region us-east-1]
###############################################################################

set -e

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NON_INTERACTIVE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --non-interactive) NON_INTERACTIVE="--non-interactive"; shift ;;
        --region) REGION="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo ""
echo "=============================================="
echo "  Switch AI Model (Existing Deployment)"
echo "  Region: $REGION"
echo "=============================================="
echo ""

# Step 1: Run model selection
echo "Step 1: Select new model..."
echo ""
cd "$PROJECT_ROOT"

if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

python3 scripts/select_model.py --region "$REGION" $NON_INTERACTIVE

# Read selected model from config
CONFIG_FILE="$PROJECT_ROOT/backend/infrastructure/model-config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: model-config.json not found. Model selection may have failed."
    exit 1
fi

MODEL_ID=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['modelId'])")
MODEL_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['modelName'])")

echo ""
echo "Step 2: Updating Lambda functions with model: $MODEL_NAME ($MODEL_ID)..."
echo ""

# Step 2: Update each Lambda's environment variable
LAMBDA_FUNCTIONS=(
    "LifeInsuranceProcessClaimHandler"
    "LifeInsuranceClaimsHandler"
    "LifeInsuranceChatHandler"
)

for FUNC_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    echo "  Updating $FUNC_NAME..."

    # Get current environment variables
    CURRENT_ENV=$(aws lambda get-function-configuration \
        --function-name "$FUNC_NAME" \
        --region "$REGION" \
        --query "Environment.Variables" \
        --output json 2>/dev/null)

    if [ $? -ne 0 ] || [ "$CURRENT_ENV" = "null" ] || [ -z "$CURRENT_ENV" ]; then
        # No existing env vars — just set MODEL_ID
        CURRENT_ENV="{}"
    fi

    # Update MODEL_ID in the environment
    UPDATED_ENV=$(echo "$CURRENT_ENV" | python3 -c "
import sys, json
env = json.load(sys.stdin)
env['MODEL_ID'] = '$MODEL_ID'
print(json.dumps({'Variables': env}))
")

    aws lambda update-function-configuration \
        --function-name "$FUNC_NAME" \
        --region "$REGION" \
        --environment "$UPDATED_ENV" \
        --query "FunctionName" \
        --output text > /dev/null 2>&1

    echo "    ✓ $FUNC_NAME → $MODEL_ID"
done

echo ""
echo "=============================================="
echo "  ✓ Model switch complete!"
echo ""
echo "  Model:  $MODEL_NAME"
echo "  ID:     $MODEL_ID"
echo "  Region: $REGION"
echo ""
echo "  All Lambda functions updated. Changes take"
echo "  effect on the next invocation (no cold start"
echo "  required — env vars update immediately)."
echo "=============================================="
echo ""

# CCOE Insurance Industry LLC — Implementation Guide

## Prerequisites

### AWS Account Setup
- AWS Account with administrator access
- AWS CLI configured with credentials
- Bedrock model access enabled: Claude Sonnet 4, Titan Embeddings
- Region: `us-east-1`

### Development Environment
- Node.js 18+ and npm
- Python 3.11+
- AWS CDK CLI: `npm install -g aws-cdk`

---

## Deployment (3 CDK Stacks)

### Phase 1: Infrastructure (15–20 minutes)

```bash
cd backend/infrastructure
npm install
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
cdk deploy LifeInsuranceInfraStack --require-approval never
```

Creates: S3 buckets (documents, frontend, knowledge bases), DynamoDB tables, Cognito user pool (3 groups), CloudFront distribution with OAI, OpenSearch Serverless collection, 3 Bedrock Knowledge Bases (Policy, Fraud, Regulatory), Bedrock Guardrail, KMS key, IAM roles.

**Important**: Run OpenSearch index creation in a separate terminal simultaneously:
```bash
pip3 install boto3 opensearch-py requests-aws4auth
python3 create_indices.py
```

### Phase 2: Agents (15–25 minutes)

```bash
cdk deploy LifeInsuranceAgentStack --require-approval never
```

Creates: 6 ECR repositories, CodeBuild projects that build ARM64 Docker images in-cloud, 6 Bedrock AgentCore Runtimes (ECR-based). No local Docker required.

**Note**: Agents are deployed as the target multi-agent architecture. For the demo, claim processing tries AgentCore Supervisor first, then falls back to direct Bedrock InvokeModel from Lambda for reliability.

### Phase 3: API (5–10 minutes)

```bash
cdk deploy LifeInsuranceApiStack --require-approval never
```

Creates: API Gateway REST API with Cognito authorizer, CloudWatch Logs role (for fresh accounts), 4 Lambda functions:
- Claims handler (CRUD + async AI processing)
- Documents handler (S3 upload/list)
- Metrics handler (dashboard analytics)
- Chat handler (FAQ chatbot)

Lambda configuration: Python 3.11, 256 MB memory, 15-minute timeout (to accommodate AgentCore parallel pipeline).

### Phase 4: Frontend (10–15 minutes)

```bash
cd ../../frontend
npm install
```

Create `.env`:
```
VITE_API_URL=https://YOUR_API_GATEWAY_URL/prod
VITE_USER_POOL_ID=us-east-1_XXXXXXX
VITE_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXX
VITE_REGION=us-east-1
```

Build and deploy:
```bash
npm run build
aws s3 sync dist/ s3://FRONTEND_BUCKET --delete
aws cloudfront create-invalidation --distribution-id DIST_ID --paths "/*"
```

### Phase 6: Test Data

Create test users in Cognito:
- `claimant1` / `Test123!Pass` → Claimants group
- `adjuster1` / `Test123!Pass` → Adjusters group
- `business1` / `Test123!Pass` → BusinessUsers group

Load test scenarios:
```bash
cd test-data
pip3 install boto3
python3 load_test_data.py
```

---

## How AI Processing Works

The Claims Lambda handles AI processing with a dual-path approach:

1. Claim submitted → DynamoDB record created → Lambda self-invokes async
2. Async handler waits 5s, fetches documents from S3, looks up policy from `POLICY_DATABASE`
3. **Primary path**: Invokes AgentCore Supervisor Runtime, which orchestrates 5 specialist agents in a 4-phase parallel pipeline:
   - Phase 1 (parallel): Authenticate + Extract Documents
   - Phase 2 (parallel): Policy Verification + Fraud Detection
   - Phase 3 (sequential): Adjudication with all prior results
   - Phase 4 (sequential): Synthesize final JSON decision (single Bedrock LLM call)
4. **Fallback path**: If AgentCore fails (cold start timeout, etc.), falls back to direct `bedrock-runtime:InvokeModel` with Claude Sonnet 4
5. AI returns structured JSON: decision, confidence, reasoning, fraud_score, document findings
6. DynamoDB updated with decision, AI insights, and `processing_path`

The Supervisor uses `concurrent.futures.ThreadPoolExecutor` for parallel phases instead of sequential Strands SDK agent reasoning, reducing pipeline time from ~214s to ~74s estimated (65% improvement).

The `POLICY_DATABASE` dict in `backend/lambda/claims/claims_handler.py` contains policy records for all 7 demo scenarios. Each record includes policy status, premiums, beneficiary designations, exclusions, and contestability information.

---

## Key Configuration

### Lambda Environment Variables
| Variable | Purpose |
|----------|---------|
| `CLAIMS_TABLE` | DynamoDB claims table name |
| `DOCUMENTS_BUCKET` | S3 bucket for uploaded documents |

### Frontend Environment Variables
| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | API Gateway URL (with `/prod` stage) |
| `VITE_USER_POOL_ID` | Cognito User Pool ID |
| `VITE_USER_POOL_CLIENT_ID` | Cognito App Client ID |
| `VITE_REGION` | AWS region (`us-east-1`) |

### AI Model Configuration
| Parameter | Value |
|-----------|-------|
| Model ID | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| Max Tokens (claims) | 2048 |
| Max Tokens (chatbot) | 512 |
| Temperature (claims) | 0.1 |
| Temperature (chatbot) | 0.3 |

---

## Monitoring

### CloudWatch Logs
- Lambda logs: `/aws/lambda/LifeInsuranceClaimsHandler`, `/aws/lambda/LifeInsuranceDocumentsHandler`, `/aws/lambda/LifeInsuranceMetricsHandler`, `/aws/lambda/LifeInsuranceChatHandler`
- AgentCore logs: `/aws/bedrock-agentcore/*`

### Key Metrics to Watch
- Lambda invocation count and errors
- Bedrock InvokeModel latency
- DynamoDB read/write capacity
- API Gateway 4xx/5xx error rates

---

## Troubleshooting

### Claims stuck in "Processing"
- Check Lambda logs for Bedrock errors
- Verify Bedrock model access is enabled for Claude Sonnet 4
- Confirm Lambda timeout is 15 minutes (900 seconds)
- Check Lambda IAM role has `bedrock:InvokeModel` permission

### Claims stuck in "Submitted"
- Async self-invoke may have failed
- Check Lambda IAM role has `lambda:InvokeFunction` permission on itself
- Verify `AWS_LAMBDA_FUNCTION_NAME` environment variable is set

### Frontend not loading
- Check CloudFront distribution status
- Verify S3 bucket has the built files (`aws s3 ls s3://FRONTEND_BUCKET/`)
- Run CloudFront invalidation after deploying new builds

### Authentication errors
- Verify Cognito user pool ID and client ID in `.env`
- Check that test users exist and are in the correct groups
- The `cognito-idp 400` error in browser console is Amplify refreshing tokens — not a real issue

### AI returns unexpected decisions
- Check `POLICY_DATABASE` in `claims_handler.py` for the policy number
- If policy not found, AI is told "NO RECORD FOUND" and will deny or escalate
- Review the AI prompt in the Lambda code for decision rules

---

## Security Hardening (Production)

- Enable VPC endpoints for Bedrock, DynamoDB, S3
- Add WAF rules on API Gateway
- Enable KMS customer-managed keys for encryption
- Configure CloudTrail for audit logging
- Implement rate limiting on API Gateway
- Add input validation and sanitization
- Review IAM policies for least privilege

---

## Cost Optimization

- DynamoDB on-demand capacity for variable workloads
- S3 Intelligent-Tiering for document storage
- CloudWatch Logs retention: 7–30 days
- Lambda right-sizing (256 MB is sufficient for current workload)
- Bedrock pay-per-token pricing — no idle costs

---

## Production Integration Points

The demo architecture has specific hooks designed for production service integration:

| Service | Current State | Production Integration |
|---------|---------------|----------------------|
| Amazon Textract | IAM permission granted (`textract:AnalyzeDocument`), not invoked | Call from Extractor agent before LLM processing — OCR scanned PDFs, extract tables from death certificates |
| Amazon Comprehend Medical | IAM permission granted (`comprehendmedical:DetectEntitiesV2`), not invoked | Call from Extractor agent — extract ICD-10 codes, medications, and diagnoses from medical records |
| Amazon SageMaker | Not configured | Deploy fraud scoring endpoint, call from Fraud Detection agent as structured input alongside RAG context |
| External Policy Systems | In-memory `POLICY_DATABASE` dict | Replace with DynamoDB table or API call to policy administration system (Guidewire, Duck Creek, etc.) |
| Document Classification | Documents categorized by upload folder name | Use Bedrock Data Automation to auto-classify document types before routing to appropriate extraction logic |

---

**For complete deployment steps**: [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md)
**For test scenarios**: [DEMO_TESTING_GUIDE.md](DEMO_TESTING_GUIDE.md)
**For architecture**: [ARCHITECTURE.md](ARCHITECTURE.md)

# Troubleshooting Guide - CCOE Insurance Industry LLC

> **Note**: This troubleshooting guide supplements DEPLOYMENT_GUIDE.md with detailed lessons learned from actual deployments.

---

## Lessons Learned from Deployment

This section documents real issues encountered during deployment and their verified solutions.

---

## LESSON 1: CDK Asset Path Resolution

**Issue**: CDK deployment fails with "Cannot find asset" errors for Lambda functions and agent code.

**Root Cause**: CDK resolves asset paths relative to the `infrastructure/` directory (where `cdk.json` lives), not relative to the source file location.

**Error Example**:
```
Error: Cannot find asset at /path/to/backend/infrastructure/../../agents/
```

**Fix**: Use `../agents/` and `../lambda/` instead of `../../agents/` and `../../lambda/` in CDK stack files.

**Files Fixed**:
- `backend/infrastructure/lib/agent-stack.ts` - Agent Lambda asset paths
- `backend/infrastructure/lib/api-stack.ts` - API Lambda handler paths

**Prevention**: Always verify asset paths relative to the `backend/infrastructure/` directory.

---

## LESSON 2: Reserved Lambda Environment Variables

**Issue**: CDK deployment fails when setting `AWS_REGION` as a Lambda environment variable.

**Root Cause**: `AWS_REGION` is a reserved environment variable set automatically by the Lambda runtime. CDK/CloudFormation rejects attempts to set it explicitly.

**Error Example**:
```
Lambda environment variables contain reserved key AWS_REGION
```

**Fix**: Remove `AWS_REGION` from Lambda environment variable configuration. Lambda functions can access the region via `process.env.AWS_REGION` (Node.js) or `os.environ['AWS_REGION']` (Python) automatically.

**Files Fixed**: `backend/infrastructure/lib/api-stack.ts`

---

## LESSON 3: S3 Block Public Access vs Public Website Hosting

**Issue**: Infrastructure stack deployment fails because the AWS account has S3 Block Public Access enabled at the account level, preventing public bucket website hosting.

**Root Cause**: Many AWS accounts (especially enterprise/organizational accounts) enforce S3 Block Public Access as a security policy. This prevents using S3 static website hosting directly.

**Error Example**:
```
Access Denied - S3 Block Public Access settings prevent public bucket policy
```

**Fix**: Use CloudFront distribution with Origin Access Identity (OAI) instead of public S3 bucket hosting.

**Implementation**:
- S3 bucket remains private (BlockPublicAccess.BLOCK_ALL)
- CloudFront distribution serves content via HTTPS
- OAI grants CloudFront read access to the private bucket
- Frontend URL becomes the CloudFront distribution domain

**Files Fixed**: `backend/infrastructure/lib/infrastructure-stack.ts`

**Benefits**:
- Works with S3 Block Public Access enabled
- HTTPS by default
- CDN caching for better performance
- Production-ready security posture

---

## LESSON 4: CDK Bootstrap Stack Recovery

**Issue**: CDK bootstrap fails because the CDKToolkit stack is in `UPDATE_ROLLBACK_FAILED` state.

**Root Cause**: A previous bootstrap or update attempt failed and couldn't roll back cleanly.

**Fix**:
```bash
# Delete the failed CDKToolkit stack
aws cloudformation delete-stack --stack-name CDKToolkit
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit

# Re-bootstrap
cdk bootstrap aws://ACCOUNT_ID/REGION
```

**Note**: Deleting CDKToolkit also deletes the staging S3 bucket. This is safe for fresh deployments but will break existing stacks that reference assets in that bucket.

---

## LESSON 5: OpenSearch Serverless Data Access Policy Principal Format

**Issue**: Knowledge Base stack fails because the OpenSearch data access policy uses an invalid principal format.

**Root Cause**: OpenSearch Serverless requires full IAM ARN format for principals. Using just the account ID is rejected.

**Error Example**:
```
Policy json is invalid, error: [$[0].Principal[0]: does not match the regex pattern
^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:root$
```

**Fix**: Use full ARN format: `arn:aws:iam::ACCOUNT_ID:root`

**Important**: The `:root` principal does NOT automatically cover assumed roles. If you're using an assumed role (e.g., via SSO, federation, or cross-account), you must also add:
- The IAM role ARN: `arn:aws:iam::ACCOUNT_ID:role/RoleName`
- The assumed role pattern: `arn:aws:sts::ACCOUNT_ID:assumed-role/RoleName/*`

**Files Fixed**: `backend/infrastructure/lib/knowledge-base-stack.ts`

---

## LESSON 6: OpenSearch Serverless Index Creation Race Condition

**Issue**: Knowledge Base stack fails because OpenSearch indices cannot be created even though the collection reports as created in CloudFormation.

**Root Cause**: OpenSearch Serverless collections go through multiple internal states after CloudFormation reports CREATE_COMPLETE:
1. CloudFormation reports collection created
2. Collection status shows CREATING
3. Collection status shows ACTIVE
4. Internal API endpoints become available (unpredictable timing, 5-15 minutes)
5. Data access policies fully propagate (additional delay)

The gap between steps 3-5 is unpredictable, causing 404 and 403 errors when trying to create indices.

**Error Examples**:
```
Failed to create index policy-guidelines-index: 404
```
```
403 Forbidden
```

**RECOMMENDED FIX - Manual Index Creation**:

The most reliable approach is to create indices manually after confirming the collection is fully ready.

1. Deploy the KB stack (it will create the collection)
2. In a separate terminal, run the automated script:
```bash
cd backend/infrastructure
python3 create_indices.py
```

This script:
- Polls for the collection to become ACTIVE (every 30 seconds)
- Creates all three indices using `opensearch-py` with proper SigV4 auth
- Handles "already exists" gracefully
- The CDK custom resource Lambda will detect existing indices and succeed

**Prerequisites for the script**:
```bash
pip3 install boto3 opensearch-py requests-aws4auth
```

**Why manual is better than automated waits**:
- OpenSearch Serverless timing is genuinely unpredictable (5-15+ minutes)
- Long Lambda waits cause SigV4 signature expiry (signatures valid for 5 minutes)
- Access policy propagation adds additional unpredictable delay
- Manual approach gives you visibility and control

---

## LESSON 7: SigV4 Signing for OpenSearch Serverless

**Issue**: Manual scripts using `urllib` with SigV4 signing get 403 Forbidden errors even with correct IAM permissions and data access policies.

**Root Cause**: When using `botocore.auth.SigV4Auth` to sign requests, the signature is computed over specific headers and body. If the HTTP client (e.g., `requests` library or `urllib.Request`) modifies headers or re-encodes the body, the signature becomes invalid.

Common mistakes:
- Signing with `AWSRequest` then creating a new `Request` object that re-encodes the body
- Using `requests.put()` which recalculates `Content-Length` and may alter headers
- Not calling `get_frozen_credentials()` for assumed role credentials

**Fix**: Use the `opensearch-py` library with `requests-aws4auth` which handles SigV4 signing correctly:

```python
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth

session = boto3.Session()
creds = session.get_credentials().get_frozen_credentials()
awsauth = AWS4Auth(creds.access_key, creds.secret_key, 'us-east-1', 'aoss', session_token=creds.token)

client = OpenSearch(
    hosts=[{'host': endpoint, 'port': 443}],
    http_auth=awsauth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection
)

client.indices.create(index='my-index', body=index_body)
```

**Key points**:
- Always use `get_frozen_credentials()` to resolve temporary credentials from assumed roles
- Use `opensearch-py` + `requests-aws4auth` instead of manual SigV4 signing
- The service name for OpenSearch Serverless is `aoss` (not `es`)
- Always include `session_token` for assumed role credentials

---

## LESSON 8: Lambda Custom Resource Timeout and Signature Expiry

**Issue**: Custom resource Lambda that creates OpenSearch indices fails with "Signature expired" error.

**Root Cause**: The Lambda was configured with long initial waits (300s) and retry loops with exponential backoff. AWS SigV4 signatures are only valid for 5 minutes. When the Lambda sleeps for extended periods, the credentials used to sign the OpenSearch API request expire.

**Error Example**:
```
Signature expired: 20260305T221130Z is now earlier than 20260305T222201Z
(20260305T222701Z - 5 min.)
```

**Fix**:
- Reduce initial wait times (120s instead of 300s)
- Use shorter retry intervals (30s increments instead of 60s)
- Refresh credentials before each API call (use `get_frozen_credentials()`)
- Set Lambda timeout to 15 minutes to accommodate retries
- Also retry on 403 errors (not just 404) since access policy propagation is also delayed

**Better approach**: Run the `create_indices.py` script manually in a separate terminal while the CDK deploy is running. The Lambda will detect existing indices and succeed.

---

## LESSON 9: CloudFormation Orphaned Resources on Stack Deletion

**Issue**: Redeploying the KB stack after deletion fails because OpenSearch policies already exist.

**Root Cause**: OpenSearch Serverless security policies and access policies are account-level resources. When CloudFormation deletes the stack, it may fail to clean up these policies (especially if the collection deletion is still in progress), leaving orphaned resources.

**Error Example**:
```
Resource of type 'AWS::OpenSearchServerless::SecurityPolicy' with identifier
'network|life-insurance-kb-network' already exists
```

**Fix**: Manually delete orphaned resources before redeploying:
```bash
# Delete policies
aws opensearchserverless delete-security-policy --name life-insurance-kb-network --type network
aws opensearchserverless delete-security-policy --name life-insurance-kb-encryption --type encryption
aws opensearchserverless delete-access-policy --name life-insurance-kb-access --type data

# Delete collection if still exists
COLLECTION_ID=$(aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].id' --output text)
if [ -n "$COLLECTION_ID" ]; then
  aws opensearchserverless delete-collection --id $COLLECTION_ID
fi

# Wait for cleanup
aws opensearchserverless list-collections --output json
# Verify empty before redeploying
```

**Prevention**: Before redeploying the KB stack, always verify that all OpenSearch resources are fully cleaned up.

---

## LESSON 10: Frontend TypeScript Configuration

**Issue**: TypeScript error in `frontend/tsconfig.json` on line 30 referencing a missing file.

**Root Cause**: The main `tsconfig.json` references `tsconfig.node.json` (standard Vite + TypeScript setup), but the file was missing from the repository.

**Fix**: Create `frontend/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

---

## LESSON 11: Bedrock Knowledge Base Requires KB Role in OpenSearch Data Access Policy

**Issue**: Bedrock Knowledge Base creation fails with 403 Forbidden even though the KB IAM role has `aoss:APIAccessAll` permissions.

**Error Example**:
```
The knowledge base storage configuration provided is invalid...
Request failed: [security_exception] 403 Forbidden
(Service: BedrockAgent, Status Code: 400)
```

**Root Cause**: OpenSearch Serverless requires BOTH:
1. An IAM policy granting `aoss:APIAccessAll` on the collection (IAM-level)
2. The role listed as a Principal in the OpenSearch data access policy (data-plane level)

The original stack only had `arn:aws:iam::ACCOUNT_ID:root` in the data access policy. The Bedrock KB service role was not included, so Bedrock was denied at the OpenSearch data-plane level even though it had IAM permissions.

**Fix**: Include the Bedrock KB role ARN in the OpenSearch data access policy. Since the role is created in the same stack, use `cdk.Fn.sub` to resolve the ARN at deploy time:

```typescript
const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
  name: `${collectionName}-access`,
  type: 'data',
  policy: cdk.Fn.sub(JSON.stringify([{
    Rules: [
      { ResourceType: 'collection', Resource: [`collection/${collectionName}`], Permission: ['aoss:*'] },
      { ResourceType: 'index', Resource: [`index/${collectionName}/*`], Permission: ['aoss:*'] },
    ],
    Principal: [
      'arn:aws:iam::${AWS::AccountId}:root',
      'arn:aws:iam::${AWS::AccountId}:role/Admin',
      '${KBRoleArn}',  // Bedrock KB service role
    ],
  }]), { KBRoleArn: kbRole.roleArn }),
});
```

**Key takeaway**: Any role that needs to access an OpenSearch Serverless collection must appear in BOTH the IAM policy AND the data access policy. This is a dual-authorization model.

---

## LESSON 12: OpenSearch Data Access Policy Propagation Delay

**Issue**: Even after adding the correct principals to the data access policy, Bedrock Knowledge Base creation still fails with 403 Forbidden.

**Root Cause**: OpenSearch Serverless data access policies take several minutes to propagate after creation. CloudFormation creates the policy, then immediately creates the collection, then immediately tries to create the Knowledge Bases. The KBs fail because the policy hasn't propagated yet.

CloudFormation dependency chains ensure ordering but NOT propagation. The collection depends on the policy, but CloudFormation moves on as soon as the policy API call returns success - it doesn't wait for the policy to be effective across all OpenSearch nodes.

**Fix**: Add a lightweight custom resource that sleeps for 3 minutes after the collection is created, giving the access policy time to propagate before Knowledge Bases are created:

```typescript
const waitFunction = new lambda.Function(this, 'PolicyPropagationWait', {
  runtime: lambda.Runtime.PYTHON_3_11,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
import time
def handler(event, context):
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': 'policy-wait'}
    wait = int(event['ResourceProperties'].get('WaitSeconds', 180))
    print(f'Waiting {wait}s for OpenSearch access policy propagation...')
    time.sleep(wait)
    return {'PhysicalResourceId': 'policy-wait'}
`),
  timeout: cdk.Duration.minutes(10),
  memorySize: 128,
});

const waitProvider = new cr.Provider(this, 'WaitProvider', {
  onEventHandler: waitFunction,
});

const policyWait = new cdk.CustomResource(this, 'PolicyPropagationDelay', {
  serviceToken: waitProvider.serviceToken,
  properties: { WaitSeconds: 180 },
});

policyWait.node.addDependency(collection);

// All Knowledge Bases depend on the wait
policyKB.node.addDependency(policyWait);
fraudKB.node.addDependency(policyWait);
regulatoryKB.node.addDependency(policyWait);
```

**Final dependency chain**:
```
encryption/network/data-access policies → collection → policyWait (3 min) → Knowledge Bases
```

**Why this works**: The sleep Lambda is trivial - no API calls, no SigV4 signing, no credentials to expire. It just introduces a guaranteed delay that gives the access policy time to propagate.

---

## Recommended Deployment Order for KB Stack

Based on lessons learned (Lessons 5-12), here is the verified approach for deploying the Knowledge Base stack:

### Step 1: Clean Up Any Previous Failed Attempts
```bash
# Delete failed stack if exists
aws cloudformation delete-stack --stack-name LifeInsuranceInfraStack
aws cloudformation wait stack-delete-complete --stack-name LifeInsuranceInfraStack

# Clean up orphaned OpenSearch resources
aws opensearchserverless delete-security-policy --name life-insurance-kb-network --type network 2>/dev/null
aws opensearchserverless delete-security-policy --name life-insurance-kb-encryption --type encryption 2>/dev/null
aws opensearchserverless delete-access-policy --name life-insurance-kb-access --type data 2>/dev/null

COLLECTION_ID=$(aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].id' --output text 2>/dev/null)
if [ -n "$COLLECTION_ID" ]; then
  aws opensearchserverless delete-collection --id $COLLECTION_ID
fi

# Verify clean slate
aws opensearchserverless list-collections --output json
```

### Step 2: Start CDK Deploy
```bash
cd backend/infrastructure
cdk deploy LifeInsuranceInfraStack --require-approval never
```

### Step 3: In a Separate Terminal, Run Index Creator
```bash
cd backend/infrastructure
pip3 install boto3 opensearch-py requests-aws4auth
python3 create_indices.py
```

The script will:
1. Poll for the collection to become ACTIVE
2. Create all three vector indices
3. The CDK custom resource will detect existing indices and succeed

### Step 3: If CDK Deploy Fails
```bash
# Clean up everything
aws cloudformation delete-stack --stack-name LifeInsuranceInfraStack
aws cloudformation wait stack-delete-complete --stack-name LifeInsuranceInfraStack

# Clean up orphaned OpenSearch resources
aws opensearchserverless delete-security-policy --name life-insurance-kb-network --type network 2>/dev/null
aws opensearchserverless delete-security-policy --name life-insurance-kb-encryption --type encryption 2>/dev/null
aws opensearchserverless delete-access-policy --name life-insurance-kb-access --type data 2>/dev/null

COLLECTION_ID=$(aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].id' --output text 2>/dev/null)
if [ -n "$COLLECTION_ID" ]; then
  aws opensearchserverless delete-collection --id $COLLECTION_ID
fi

# Wait for full cleanup
sleep 60
aws opensearchserverless list-collections --output json

# Redeploy
cdk deploy LifeInsuranceInfraStack --require-approval never
# And run create_indices.py in parallel again
```

---

## Common Deployment Issues and Solutions

### Issue: CDK Bootstrap Fails

**Error**: `Unable to resolve AWS account to use`

**Solution**:
```bash
aws configure
aws sts get-caller-identity
cdk bootstrap
```

---

### Issue: Stack Already Exists

**Error**: `Stack [StackName] already exists`

**Solution**:
```bash
# Option 1: Update existing stack
cdk deploy [StackName] --require-approval never

# Option 2: Destroy and redeploy
cdk destroy [StackName]
cdk deploy [StackName] --require-approval never
```

---

### Issue: Bedrock Model Access Denied

**Error**: `You don't have access to the model`

**Solution**:
1. Go to AWS Console → Bedrock → Model access
2. Click "Manage model access"
3. Enable: Claude 3.5 Sonnet, Claude 3 Haiku, Titan Embeddings v2
4. Wait for "Access granted" status
5. Retry deployment

---

### Issue: Lambda Function Not Found

**Error**: `Function not found`

**Solution**:
```bash
cd backend/infrastructure
cdk deploy LifeInsuranceAgentStack --require-approval never
# Agents are deployed as AgentCore Runtimes via CDK — no manual deploy_agents.py needed
```

---

### Issue: Frontend Shows CORS Error

**Error**: `Access blocked by CORS policy`

**Solution**:
1. Check API Gateway CORS settings in AWS Console
2. Verify frontend URL is in allowed origins
3. Redeploy API stack:
```bash
cdk deploy LifeInsuranceApiStack --require-approval never
```

---

### Issue: Knowledge Base Sync Fails

**Error**: `Failed to start ingestion job`

**Solution**:
```bash
aws s3 ls s3://life-insurance-kb-{account}-{region}/policy-guidelines/
# If empty:
cd backend/knowledge-bases
python3 load_knowledge_bases.py
python3 sync_knowledge_bases.py
```

---

### Issue: Claims Not Processing

**Symptoms**: Claim stuck in "Submitted" status

**Solution**:
```bash
aws logs tail /aws/lambda/LifeInsuranceClaims-SupervisorAgent --follow
aws logs filter-log-events \
  --log-group-name /aws/lambda/LifeInsuranceClaims-SupervisorAgent \
  --filter-pattern "ERROR"
```

---

## Debugging Commands

```bash
# List all CloudFormation stacks
aws cloudformation list-stacks --query "StackSummaries[?contains(StackName, 'LifeInsurance')].{Name:StackName, Status:StackStatus}"

# List Lambda functions
aws lambda list-functions --query "Functions[?contains(FunctionName, 'LifeInsurance')].FunctionName"

# List DynamoDB tables
aws dynamodb list-tables --query "TableNames[?contains(@, 'LifeInsurance')]"

# List S3 buckets
aws s3 ls | grep life-insurance

# Check OpenSearch collections
aws opensearchserverless list-collections --output json

# Check OpenSearch policies
aws opensearchserverless list-security-policies --type network
aws opensearchserverless list-security-policies --type encryption
aws opensearchserverless list-access-policies --type data

# Check Cognito user pool
aws cognito-idp list-user-pools --max-results 10

# Tail Lambda logs
aws logs tail /aws/lambda/{function-name} --follow
```

---

## LESSON 13: Direct Code Deploy vs Container Deploy for AgentCore

**Context**: The initial agent-stack.ts used the Container approach — ECR repos, CodeBuild projects, Docker builds, and trigger Lambda custom resources for each of the 6 agents. This created ~18 extra AWS resources and added significant deployment complexity.

**Decision**: Switched to Direct Code Deploy (S3-based) approach for the demo.

**How Direct Code Deploy works**:
1. CDK uploads each agent's Python source directory to S3 as an asset (zip)
2. The `AWS::BedrockAgentCore::Runtime` resource uses `S3CodeConfiguration` instead of `ContainerConfiguration`
3. AgentCore automatically handles containerization in the cloud — no Docker, no ECR, no CodeBuild
4. Each agent directory needs its own `requirements.txt` so AgentCore knows what packages to install

**CloudFormation property structure**:
```yaml
AgentRuntimeArtifact:
  S3CodeConfiguration:
    S3Uri: s3://cdk-bucket/asset-hash.zip
    EntryPoint: agent_module.py
```

**vs Container approach**:
```yaml
AgentRuntimeArtifact:
  ContainerConfiguration:
    ContainerUri: 123456789.dkr.ecr.us-east-1.amazonaws.com/repo:latest
```

**Pros of Direct Code Deploy**:
- ~18 fewer AWS resources (no ECR repos, CodeBuild projects, trigger Lambda)
- Faster deploys (skip Docker build step)
- Simpler to understand, debug, and tear down
- Perfect for demos and prototypes

**Cons of Direct Code Deploy**:
- Less control over base image and system packages
- Not ideal if you need custom OS-level dependencies
- Container approach better for production with reproducible builds

**Resolution**: Rewrote `agent-stack.ts` to use `s3assets.Asset` + `S3CodeConfiguration`. Added `requirements.txt` to each agent source directory. Removed all ECR, CodeBuild, and custom resource infrastructure.

---

## LESSON 14: Lambda CORS Headers and Decimal Serialization

**Issue**: Frontend receives CORS errors and 500 errors from Lambda handlers.

**Root Cause**: Multiple issues:
1. Lambda responses missing `Access-Control-Allow-Origin` and related CORS headers
2. Python's `json.dumps()` cannot serialize `Decimal` types returned by DynamoDB
3. DynamoDB `boto3.resource` returns `Decimal` for all numeric values

**Fix**:
- Add CORS headers to every Lambda response (including error responses)
- Create a `DecimalEncoder` class extending `json.JSONEncoder` to convert `Decimal` to `int` or `float`
- Use `json.dumps(body, cls=DecimalEncoder)` in all response functions

```python
class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)
```

**Files Fixed**: `backend/lambda/claims/claims_handler.py`, `backend/lambda/metrics/metrics_handler.py`

---

## LESSON 15: DynamoDB Composite Key — Query vs GetItem

**Issue**: Claims created successfully but `get_claim` returns "Claim not found" even though the item exists in DynamoDB.

**Root Cause**: The Claims table uses a composite key: `claimId` (partition key) + `timestamp` (sort key). Using `get_item()` requires BOTH keys, but the API only has the `claimId`. Using `get_item()` with only the partition key silently returns nothing.

**Fix**: Use `query()` with `KeyConditionExpression` instead of `get_item()`:

```python
from boto3.dynamodb.conditions import Key

def _get_claim_item(claim_id):
    result = table.query(
        KeyConditionExpression=Key('claimId').eq(claim_id),
        Limit=1
    )
    items = result.get('Items', [])
    return items[0] if items else None
```

**Important**: All CRUD operations (update, approve, deny) must also query first to get both keys before calling `update_item()`.

**Files Fixed**: `backend/lambda/claims/claims_handler.py`

---

## LESSON 16: AgentCore Runtime Cold Start Timeout

**Issue**: Invoking AgentCore Supervisor runtime from Lambda returns `RuntimeClientError: Runtime initialization time exceeded 30s`.

**Root Cause**: AgentCore Direct Code Deploy runs `pip install` from `requirements.txt` on cold start. The `strands-agents` package and its dependencies take >30 seconds to install, exceeding the default initialization timeout.

**Attempted Solutions**:
1. Pre-packaging dependencies into `*_package` directories (89MB each) — AgentCore returned `HandlerInternalFailure` (too large or wrong format)
2. Reducing dependencies — still too slow for cold start

**Interim Solution (since superseded)**: During initial deployment, AgentCore was bypassed temporarily. Lambda called Bedrock InvokeModel directly while AgentCore cold-start issues were resolved. **Current state**: AgentCore Supervisor is the primary processing path. Direct Bedrock InvokeModel is retained only as a fallback. See Lesson 32 for the resolution.

**Architecture Decision**: Lambda self-invokes with `InvocationType='Event'` for async processing (API Gateway has 29s hard limit). The async invocation marks the claim as "processing", calls Bedrock, parses the AI response, and updates DynamoDB with the decision.

**Files Fixed**: `backend/lambda/claims/claims_handler.py`, `backend/infrastructure/lib/api-stack.ts`

---

## LESSON 17: Bedrock Model ID — Cross-Region Inference Profiles

**Issue**: Bedrock `InvokeModel` returns `AccessDeniedException` or `ModelNotFound` when using raw model IDs.

**Root Cause**: Some Bedrock models require cross-region inference profile IDs (prefixed with `us.`) instead of raw model IDs. Additionally, Claude 3.5 Sonnet v2 was marked as legacy.

**Fix**: Use the cross-region inference profile ID for Claude Sonnet 4:
```python
MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0'
```

**Key Points**:
- Always use `us.` prefix for cross-region inference
- Check Bedrock console for the latest available model versions
- Claude Sonnet 4 is the current recommended model (as of March 2026)

---

## LESSON 18: Frontend Field Name Mismatches

**Issue**: Frontend components show blank or zero values despite backend returning correct data.

**Root Cause**: Frontend TypeScript code used different field names than what the backend API returns. Examples:
- `claim.amount` vs `claim.claimAmount`
- `claim.createdAt` vs `claim.submittedAt` (epoch seconds)
- `metrics.approved` vs `metrics.approvedClaims`
- `data.claims` vs raw array response

**Fix**: Audit all frontend components against actual API responses. Use `console.log()` or browser DevTools Network tab to inspect actual response payloads, then update field references.

**Files Fixed**: `ClaimDetails.tsx`, `MyClaims.tsx`, `AdjusterWorkbench.tsx`, `BusinessDashboard.tsx`

---

## LESSON 19: Business Dashboard Metrics — Computing Real Stats

**Issue**: Business Dashboard shows "N/A" and zeros for all metrics except Total Claims.

**Root Cause**: The metrics Lambda was returning field names that didn't match what the frontend expected, and several metrics (STP rate, agent invocations, fraud detected) were not being computed at all.

**Fix**: Updated `metrics_handler.py` to:
1. Compute all stats from actual DynamoDB claim data (not hardcoded)
2. Return field names matching frontend expectations (`approvedClaims`, `deniedClaims`, `escalatedClaims`, `pendingClaims`)
3. Calculate STP rate from claims that were auto-decided by AI (have `processingDetails` but no `adjusterNotes`)
4. Count agent invocations from claims with `processingDetails`
5. Count fraud detections from claims where `fraud_score >= 0.7`
6. Return `recentClaims` array for the Claims Overview table
7. Compute `avgProcessingTime` from `submittedAt` to `updatedAt` delta

**Files Fixed**: `backend/lambda/metrics/metrics_handler.py`, `frontend/src/pages/BusinessDashboard/BusinessDashboard.tsx`

---

## LESSON 20: Adjuster Workbench Not Showing Escalated Claims

**Issue**: Claims escalated by AI (scenarios 4, 5, 7) don't appear in the Adjuster Workbench.

**Root Cause**: The AdjusterWorkbench component was filtering claims with `status === 'submitted'` only. Escalated claims have status `'escalated'`, not `'submitted'`.

**Fix**: Changed the filter to include multiple statuses:
```typescript
const reviewStatuses = ['escalated', 'submitted', 'processing']
setClaims(all.filter((c: any) => reviewStatuses.includes(c.status)))
```

**Files Fixed**: `frontend/src/pages/AdjusterWorkbench/AdjusterWorkbench.tsx`

---

## LESSON 21: AI Claims Assistant Chatbot Architecture

**Context**: Added a lightweight FAQ chatbot to guide claimants through the claims process with empathy.

**Architecture Decision**: Used direct Bedrock InvokeModel from a dedicated Chat Lambda (same pattern as claims processing) rather than AgentCore Runtime. Rationale:
- Stateless FAQ bot — no need for AgentCore's session management, memory, or tool use
- Simpler, cheaper, faster cold-start than AgentCore
- AgentCore is designed for complex multi-step agents, not simple Q&A

**Implementation**:
- `backend/lambda/chat/chat_handler.py` — Lambda calling Claude Sonnet 4 with a system prompt containing all FAQ knowledge
- `/chat` POST route on API Gateway with Cognito auth
- `frontend/src/components/ChatWidget/ChatWidget.tsx` — floating chat widget
- Conversation history (last 6 messages) sent with each request for context
- 512 max tokens, temperature 0.3 for consistent responses

**Key Design Choices**:
- ChatWidget only renders for Claimant role (adjusters and business users don't see it)
- Auto-opens after 1.5 seconds with empathetic greeting for grieving users
- Suggestion chips for common questions on first interaction
- System prompt instructs the AI to be warm, empathetic, and concise (< 150 words)
- AI is restricted to claims-related topics only — redirects legal/tax/financial questions to professionals

**Files**: `backend/lambda/chat/chat_handler.py`, `backend/infrastructure/lib/api-stack.ts`, `frontend/src/services/api.ts`, `frontend/src/components/ChatWidget/ChatWidget.tsx`, `frontend/src/App.tsx`

---

## LESSON 22: AI Processing Flow Sidebar — Adjuster vs Claimant Placement

**Context**: The 8-step AI Processing Flow sidebar was initially placed on the Claimant ClaimDetails page. User feedback indicated it belongs on the Adjuster Workbench instead.

**Rationale**: Claimants don't need to see the internal multi-agent pipeline details (death registry lookups, fraud analysis scores, MCP tool calls). Adjusters reviewing claims benefit from seeing exactly what each AI agent did and where issues were flagged.

**Implementation**:
- Removed `FlowStep`, `getStepStatuses`, `ProcessingFlow` components and collapsible sidebar from `ClaimDetails.tsx`
- Added all processing flow code to `AdjusterWorkbench.tsx` — sidebar appears on the right when a claim is selected
- Added auto-polling (3-second interval) while claims are in `submitted` or `processing` status
- Sidebar shows animated spinners for active steps, checkmarks for completed, X for failed
- Each step shows agent badge, detail text, and simulated MCP tool call in monospace

**The 8 Steps**:
1. Claim Received (System)
2. Document Verification (Extractor Agent) — `bedrock:InvokeModel`
3. Death Registry Lookup (Authenticator Agent) — `mcp:death_registry.verify_record`
4. Obituary & Public Records (Authenticator Agent) — `mcp:web_search.find_obituary`
5. Beneficiary Authentication (Authenticator Agent) — `mcp:identity_verification.validate`
6. Policy Verification (Policy Verification Agent) — `knowledge_base:policy-guidelines`
7. Fraud Analysis (Fraud Detection Agent) — `knowledge_base:fraud-patterns`
8. Adjudication Decision (Adjudication Agent) — `knowledge_base:regulatory`

**Files**: `frontend/src/pages/ClaimantPortal/ClaimDetails.tsx`, `frontend/src/pages/AdjusterWorkbench/AdjusterWorkbench.tsx`

---

## LESSON 23: Document Verification in AI Processing

**Context**: Enhanced claims processing to fetch uploaded documents from S3 and include their text content in the AI prompt for verification.

**Implementation**:
- Added `_fetch_claim_documents()` function in `claims_handler.py` that lists and reads documents from S3 under `claims/{claimId}/`
- 5-second delay in async handler before fetching documents (allows upload to complete)
- Document text content included in AI prompt under `SUBMITTED DOCUMENTS` section
- AI prompt includes `DOCUMENT VERIFICATION INSTRUCTIONS` telling Claude to cross-reference documents against claim data
- AI returns `documents_verified` (boolean) and `document_findings` (text) fields
- Document findings displayed in both ClaimDetails (claimant) and AdjusterWorkbench (adjuster)
- Increased `max_tokens` to 2048 to accommodate longer responses with document analysis

**Files**: `backend/lambda/claims/claims_handler.py`

---

## LESSON 24: KMS Key Race Condition with DynamoDB

**Issue**: DynamoDB table creation fails with `KMS validation error: Key does not exist` during fresh account deployment.

**Root Cause**: A custom KMS key was created in the same stack and referenced by the S3 Documents bucket. CloudFormation attempted to validate the KMS key ARN for DynamoDB before the key was fully provisioned, even though DynamoDB was configured with `AWS_MANAGED` encryption (which doesn't use a custom key). The race condition occurred because CloudFormation's internal dependency resolution created an implicit link through the shared stack resources.

**Error Example**:
```
KMS validation error: com.amazonaws.services.kms.model.NotFoundException:
Key 'arn:aws:kms:us-east-1:ACCOUNT_ID:key/...' does not exist
```

**Fix**: Removed the custom KMS key entirely. Switched the Documents S3 bucket from `BucketEncryption.KMS` with a custom key to `BucketEncryption.S3_MANAGED` (SSE-S3). Data is still encrypted at rest using AWS-managed keys — sufficient for demo/POC environments.

**Files Fixed**: `backend/infrastructure/lib/infrastructure-stack.ts`

**Prevention**: For demo deployments, prefer `S3_MANAGED` encryption over custom KMS keys unless you specifically need key rotation control or cross-account access.

---

## LESSON 25: OpenSearch Data Access Policy — Wildcard Role ARN Rejected

**Issue**: OpenSearch Serverless data access policy creation fails with regex validation error when using wildcard role patterns.

**Root Cause**: AWS tightened validation on OpenSearch Serverless access policy principals. The pattern `arn:aws:iam::ACCOUNT_ID:role/*` (wildcard matching all roles) is no longer accepted. Principals must be specific ARNs matching one of the allowed regex patterns: account root, specific IAM user/role, assumed-role, SSO identity, or SAML federation.

**Error Example**:
```
Policy json is invalid, error: [$[0].Principal[1]: does not match the regex pattern
^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:(user|role)(/[\w+=,.@-]+)*/[\w+=,.@-]{1,64}$]
```

**Fix**: Removed the wildcard `arn:aws:iam::ACCOUNT_ID:role/*` principal. Kept only:
- `arn:aws:iam::ACCOUNT_ID:root` (account root — covers console access)
- The specific KB role ARN (resolved via `cdk.Fn.sub`)

```typescript
Principal: [
  'arn:aws:iam::${AWS::AccountId}:root',
  '${KBRoleArn}',
],
```

**Files Fixed**: `backend/infrastructure/lib/infrastructure-stack.ts`

**Note**: If additional roles need OpenSearch access (e.g., for `create_indices.py`), add their specific ARNs to the Principal array. The account root principal covers IAM users and roles that sign in directly.

---

## LESSON 26: AgentCore Requires ARM64 Container Images

**Issue**: All 6 AgentCore runtime creations fail with "Architecture incompatible" error.

**Root Cause**: Bedrock AgentCore runtimes run on Graviton (ARM64) infrastructure. The CodeBuild project was using `LinuxBuildImage.STANDARD_7_0` which builds x86_64 (amd64) Docker images by default. AgentCore rejects non-ARM64 images.

**Error Example**:
```
Architecture incompatible for uri 'ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/life-insurance/extractor:latest'.
Supported architectures: [arm64]
```

**Fix** (two changes required):

1. **Dockerfiles** — Add explicit ARM64 platform target to all 6 agent Dockerfiles:
```dockerfile
FROM --platform=linux/arm64 python:3.11-slim
```

2. **CodeBuild** — Switch to an ARM build environment:
```typescript
environment: {
  buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
  privileged: true,
  computeType: codebuild.ComputeType.LARGE, // ARM doesn't support MEDIUM
},
```

**Files Fixed**: All 6 `backend/agents/*/Dockerfile`, `backend/infrastructure/lib/agent-stack.ts`

**Key Points**:
- ARM CodeBuild requires `ComputeType.LARGE` minimum (MEDIUM not supported for ARM)
- Always use `--platform=linux/arm64` in Dockerfiles when targeting AgentCore
- This applies to any ECR-based AgentCore deployment, not just this project

---

## LESSON 27: API Gateway CloudWatch Logs Role — Fresh Account Setup

**Issue**: API Gateway stage deployment fails with "CloudWatch Logs role ARN must be set in account settings to enable logging."

**Root Cause**: API Gateway requires a one-time account-level configuration to set a CloudWatch Logs role before any API stage can enable logging (`loggingLevel: INFO`, `dataTraceEnabled: true`). In a fresh AWS account, this has never been configured. Existing accounts that have previously deployed API Gateways with logging already have this set.

**Error Example**:
```
CloudWatch Logs role ARN must be set in account settings to enable logging
(Service: ApiGateway, Status Code: 400)
```

**Fix**: Add a `CfnAccount` resource in the API stack that creates the CloudWatch role and configures it at the account level, with an explicit dependency so the API stage waits for it:

```typescript
const apiGwLogsRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
  assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AmazonAPIGatewayPushToCloudWatchLogs'
    ),
  ],
});

const apiGwAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
  cloudWatchRoleArn: apiGwLogsRole.roleArn,
});

// After creating the RestApi:
this.api.deploymentStage.node.addDependency(apiGwAccount);
```

**Files Fixed**: `backend/infrastructure/lib/api-stack.ts`

**Note**: This is a one-time account-level setting. Once configured, it persists across all API Gateway deployments in the account. The `CfnAccount` resource is idempotent — safe to include even if already configured.

---

## LESSON 28: AgentCore Container Crash — Missing AWS_REGION in boto3 Calls

**Issue**: All claims processed via `bedrock_direct` fallback path. AgentCore Supervisor runtime never successfully processes a claim.

**Symptoms**:
- Claims Lambda logs: `AgentCore invocation failed: An error occurred (RuntimeClientError) when calling the InvokeAgentRuntime operation: An error occurred when starting the runtime.`
- Every claim's `processingDetails` shows `"processing_path": "bedrock_direct"`

**Root Cause**: The Supervisor agent (`supervisor.py` line 17) initializes a DynamoDB resource at module level without specifying a region:
```python
dynamodb = boto3.resource('dynamodb')  # No region_name
```

Inside AgentCore containers, the `AWS_REGION` environment variable is NOT automatically set (unlike Lambda). This causes `botocore.exceptions.NoRegionError: You must specify a region.` at import time, crashing the container before it can handle any requests.

**Diagnosis Steps**:
1. Checked Claims Lambda logs in CloudWatch (`/aws/lambda/LifeInsuranceClaimsHandler`) — found consistent `RuntimeClientError` on every claim
2. Found AgentCore Supervisor runtime logs at `/aws/bedrock-agentcore/runtimes/LifeInsurance_SupervisorAgent-{id}-DEFAULT`
3. Supervisor logs showed the full traceback:
```
File "/app/supervisor.py", line 17, in <module>
    dynamodb = boto3.resource('dynamodb')
botocore.exceptions.NoRegionError: You must specify a region.
```

**Scope of Impact**: 5 of 6 agents had the same bug — any `boto3.client()` or `boto3.resource()` call without `region_name` would fail inside AgentCore containers:

| Agent | Affected Call | When It Fails |
|-------|-------------|---------------|
| Supervisor | `boto3.resource('dynamodb')` at module level | Container startup (crash) |
| Extractor | `boto3.client('textract')` and `boto3.client('comprehendmedical')` in `@tool` functions | Tool invocation |
| Policy Verification | `boto3.client('bedrock-agent-runtime')` in `@tool` function | Tool invocation |
| Fraud Detection | `boto3.client('bedrock-agent-runtime')` in `@tool` function | Tool invocation |
| Adjudication | `boto3.client('bedrock-agent-runtime')` and `boto3.resource('dynamodb')` in `@tool` functions | Tool invocation |
| Authenticator | No boto3 calls | Not affected |

**Fix**: Add `region_name` to every `boto3.client()` and `boto3.resource()` call across all agent files:
```python
REGION = os.environ.get('AWS_REGION', 'us-east-1')
dynamodb = boto3.resource('dynamodb', region_name=REGION)
```

**Files Fixed**: `backend/agents/supervisor/supervisor.py`, `backend/agents/extractor/extractor.py`, `backend/agents/policy_verification/policy_verification.py`, `backend/agents/fraud_detection/fraud_detection.py`, `backend/agents/adjudication/adjudication.py`

**Deployment**: Requires `cdk deploy LifeInsuranceAgentStack` from `backend/infrastructure/` to rebuild ECR images via CodeBuild and update AgentCore runtimes.

**Key Takeaway**: Unlike Lambda, AgentCore containers do NOT have `AWS_REGION` set automatically. Always pass `region_name` explicitly to all boto3 clients in AgentCore agent code.

---

## LESSON 29: AgentCore SSE Stream Parsing — Empty Response Body (IN PROGRESS)

**Issue**: After fixing the region bug (Lesson 28), the Supervisor runtime boots and completes invocations successfully, but the Claims Lambda still falls back to `bedrock_direct`.

**Symptoms**:
- Claims Lambda logs: `AgentCore invocation failed: Expecting value: line 1 column 1 (char 0). Falling back to direct Bedrock.`
- Supervisor runtime logs show: `"Invocation completed successfully (15.635s)"` — the agent IS running and returning results
- The Lambda receives an empty string and `json.loads('')` throws `JSONDecodeError`

**Root Cause**: The `_invoke_agentcore_supervisor()` function in `claims_handler.py` reads the AgentCore response using `iter_lines(chunk_size=10)`. The tiny 10-byte chunk size fragments SSE (Server-Sent Events) frames mid-line. The `data: ` prefix stripping logic then fails to reassemble the response correctly, resulting in an empty `result_text`.

**Diagnosis Steps**:
1. After deploying the Lesson 28 fix, submitted test claims — still `bedrock_direct`
2. Claims Lambda logs showed new error: `Expecting value: line 1 column 1 (char 0)` (changed from `RuntimeClientError`)
3. Supervisor runtime logs confirmed successful completion — the agent was working
4. Identified the stream parsing code as the culprit: `iter_lines(chunk_size=10)` with naive `data: ` stripping

**Fix Applied** (pending verification):
- Increased `chunk_size` from 10 to 1024 bytes
- Added filtering for SSE `event:` lines that aren't data
- Added debug logging for response length and body keys
- Added robust 3-strategy JSON extraction: direct parse → markdown code block → brace-matching
- Added 90-second read timeout on the `bedrock-agentcore` boto3 client

**Root Cause Update**: The SSE chunk_size fix resolved the stream reading issue. The response was being read correctly (1654 bytes), but the Supervisor agent returned prose markdown (not JSON). Added multi-strategy JSON extraction to handle: pure JSON, markdown-wrapped JSON, and JSON embedded in prose text. Also added the JSON output format requirement to the Supervisor's system prompt.

**Status**: SSE parsing verified working. JSON extraction and system prompt fix deployed.

**Files Fixed**: `backend/lambda/claims/claims_handler.py`, `backend/agents/supervisor/supervisor.py`

---

## LESSON 30: Cascading AgentCore Cold Starts — Multi-Agent Pipeline Timeout

**Issue**: After fixing Lessons 28-29, the Supervisor agent boots and runs successfully, but the full multi-agent pipeline takes 7+ minutes because each specialist agent has its own ~90-second cold start.

**Symptoms**:
- Claims Lambda appears to "loop" or hang for extended periods
- Supervisor runtime logs show multiple invocations completing in 90-100 seconds each — these are the specialist agent calls (authenticate, extract, verify, fraud, adjudicate)
- Lambda eventually times out (was 120s) and falls back to Bedrock direct

**Root Cause**: The Supervisor agent uses Strands SDK tools that invoke 5 specialist AgentCore runtimes sequentially via `invoke_specialist()`. Each specialist runtime has its own cold start (~90s for `pip install` of dependencies). The total pipeline time is:
- Supervisor cold start: ~90s
- Authenticator call: ~90s
- Extractor call: ~90s
- Policy Verification call: ~90s
- Fraud Detection call: ~90s
- Adjudication call: ~90s
- Total: ~9 minutes (sequential cold starts)

After warm-up, each specialist call takes ~15-30s, bringing total pipeline time to ~2-3 minutes.

**Diagnosis Steps**:
1. Supervisor runtime logs showed invocations at 16:39, 16:40, 16:42, 16:43 — each taking 90-100s
2. These were NOT retries — they were sequential specialist agent calls from the Supervisor's tool loop
3. Lambda timeout (120s) was far too short for the full pipeline
4. Different session IDs confirmed these were separate specialist invocations, not Supervisor retries

**Fix** (three changes):

1. **Increased Lambda timeout** from 120s to 15 minutes — gives the full pipeline time to complete even with cold starts:
```typescript
timeout: cdk.Duration.minutes(15),
```

2. **Added warm-up Lambda** — EventBridge rule triggers every 5 minutes, invoking all 6 AgentCore runtimes in parallel with a lightweight health check payload. This keeps containers warm and eliminates cascading cold starts:
```python
# Warm-up Lambda invokes all runtimes concurrently
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    futures = {executor.submit(ping, arn): arn for arn in arns}
```

3. **Added 90-second read timeout** on the Lambda's `bedrock-agentcore` client to prevent indefinite hangs:
```python
from botocore.config import Config
agentcore_config = Config(read_timeout=90, connect_timeout=10)
```

4. **Kept Bedrock direct fallback** — if AgentCore pipeline fails or times out, claims still get processed via direct Bedrock InvokeModel.

**Files Fixed**: `backend/infrastructure/lib/agent-stack.ts` (warm-up Lambda + EventBridge), `backend/infrastructure/lib/api-stack.ts` (Lambda timeout), `backend/lambda/claims/claims_handler.py` (client timeout)

**Expected Behavior After Fix**:
- First claim after deployment: ~9 minutes (all cold starts, falls back to Bedrock direct due to Lambda timeout)
- Warm-up Lambda fires every 5 minutes, keeping all runtimes warm
- Subsequent claims: ~2-3 minutes via full AgentCore pipeline
- If AgentCore fails: automatic fallback to Bedrock direct (~10 seconds)

**Key Takeaway**: Multi-agent AgentCore architectures with sequential specialist calls suffer from cascading cold starts. A warm-up mechanism is essential for production use. Consider parallel specialist invocation or reducing the number of sequential agent hops for latency-sensitive workloads.

---

## LESSON 31: AgentCore Specialist Agents Lack Context — Wrong Decisions (STP Denied Instead of Approved)

**Issue**: The AgentCore multi-agent pipeline completes successfully (`processing_path: agentcore`), but produces incorrect decisions. Scenario 1 (STP — Robert Mitchell, policy LIP-2019-087234, $25K claim) is DENIED instead of APPROVED.

**Root Cause**: The Supervisor agent was passing only basic claim metadata (name, policy number, amount) to specialist agents. The specialists had no access to:
1. The **policy database record** — containing status, premium history, contestability, and notes that explicitly mark this as an STP auto-approve candidate
2. The **S3 claim documents** — death certificates, beneficiary IDs, medical records uploaded by the claimant

Without this context, the Authenticator flagged "impossible future death date" and "missing documentation", the Fraud Detection agent couldn't assess risk properly, and the Adjudication agent denied the claim based on incomplete information.

Meanwhile, the Bedrock direct fallback path worked correctly because `_process_claim_with_bedrock()` in `claims_handler.py` fetches both the policy record and S3 documents, then passes everything in a single rich `PROCESSING_PROMPT`.

**Fix**:
1. Added `POLICY_DATABASE` dictionary to `supervisor.py` (mirrors `claims_handler.py`)
2. Added `fetch_claim_documents()` function to Supervisor — reads documents from S3 using the `DOCUMENTS_BUCKET` env var
3. Added `lookup_policy()` function to Supervisor — looks up policy record by policy number
4. Updated `invoke()` entrypoint to enrich claim data with policy record and documents BEFORE passing to the Strands agent
5. Updated all specialist tool functions (`authenticate_claim`, `extract_documents`, `verify_policy`, `detect_fraud`, `adjudicate_claim`) to accept and pass policy record and document content to each specialist agent
6. Updated Supervisor's `SYSTEM_PROMPT` with the same decision rules and clarifications as the Bedrock direct path (partial claims are normal, long-standing policies are low risk, etc.)
7. Increased Lambda `read_timeout` from 90s to 600s to accommodate the full multi-agent pipeline

**Files Changed**:
- `backend/agents/supervisor/supervisor.py` — Major rewrite: added policy DB, S3 fetch, enriched tool signatures, updated system prompt
- `backend/lambda/claims/claims_handler.py` — Increased `read_timeout` from 90s to 600s

**Verification**: VERIFIED — Scenario 1 (STP) approved successfully via AgentCore path. Decision: approved, confidence 0.95, fraud_score 0.1, processing_path: agentcore. Full pipeline completed in 214 seconds (~3.5 minutes) across 5 specialist agents.

**Key Takeaway**: In multi-agent architectures, the orchestrator (Supervisor) must ensure each specialist receives the same quality of context that a monolithic approach would have. Simply passing claim metadata without supporting documents and policy records leads to hallucinated concerns and wrong decisions. The Supervisor should act as a context enrichment layer, fetching all relevant data before dispatching to specialists.

---

## LESSON 32: AgentCore Multi-Agent Pipeline — Parallel Execution (IMPLEMENTED ✅)

**Context**: After fixing Lesson 31 (context enrichment), the full AgentCore multi-agent pipeline completed successfully but took ~214 seconds (~3.5 minutes) due to sequential Strands SDK orchestration. Parallelization was implemented to reduce this.

**Before (Sequential Strands Agent Orchestration)**:
```
Authenticate → Extract → Verify Policy → Detect Fraud → Adjudicate → Update Status
   ~9s          ~26s        ~15s            ~3-18s          ~5-28s        ~2s
                                                    Total: ~214s
```

The Strands SDK agent called specialists sequentially, sometimes invoking them twice as it reasoned through the workflow. LLM reasoning between tool calls added ~30-40s of overhead.

**After (Explicit 4-Phase Parallel Pipeline)**:
```
Phase 1 (parallel):  Authenticate + Extract Documents     (~26s, limited by slowest)
Phase 2 (parallel):  Verify Policy + Detect Fraud         (~18s, limited by slowest)
Phase 3 (sequential): Adjudicate (needs all Phase 1+2 results)  (~28s)
Phase 4 (sequential): Synthesize final JSON (single Bedrock LLM call)  (~5s)
                                                    Total: ~74s estimated
```

**Improvement**: From ~214s down to ~74s estimated (65% reduction).

**Implementation Details**:

1. **Replaced Strands agent orchestration with explicit Python orchestration** in `supervisor.py`:
   - The `invoke()` entrypoint now uses `concurrent.futures.ThreadPoolExecutor` for parallel phases
   - Added `_call_specialist_raw()` helper — calls a specialist AgentCore runtime and returns raw response text
   - Added `_synthesize_decision()` helper — single Bedrock `InvokeModel` call (Claude Sonnet 4) to produce the final structured JSON decision from all specialist outputs
   - The Strands agent (`create_supervisor()`) is kept only as a fallback for non-claim prompts

2. **4-Phase Pipeline**:
   - Phase 1: `Authenticate` + `Extract` run in parallel via ThreadPoolExecutor(max_workers=2). Both receive full claim data, policy record, and documents.
   - Phase 2: `PolicyVerification` + `FraudDetection` run in parallel. Fraud detection receives Phase 1 extract results for cross-referencing.
   - Phase 3: `Adjudication` runs sequentially with all Phase 1+2 results. Receives the same ordered decision rules as the Bedrock direct path.
   - Phase 4: `_synthesize_decision()` makes a single Bedrock LLM call to produce the final JSON response from all specialist outputs. This replaces the Strands agent's multi-turn reasoning.

3. **Decision rules aligned** between AgentCore and Bedrock direct paths:
   - Fraud denial threshold: `>= 0.7` (both paths)
   - Escalation range: `0.5-0.7` (both paths)
   - Same ordered rule set in both the synthesis prompt and the Bedrock direct prompt

4. **Deploy timestamp** added to AgentCore runtime Description field in `agent-stack.ts` to force container re-pull on each `cdk deploy`.

**Verification Results** (March 13, 2026):
- All 7 scenarios tested and verified correct via AgentCore path
- No fallbacks to Bedrock direct observed across multiple test runs
- Decisions matched expected outcomes for all scenarios:
  - Scenario 1 (STP): Approved ✅
  - Scenario 2 (Lapsed): Denied ✅
  - Scenario 3 (Fraud): Denied ✅
  - Scenario 4 (High-Value): Escalated ✅
  - Scenario 5 (Missing Docs): Escalated ✅
  - Scenario 6 (Suicide): Denied ✅
  - Scenario 7 (Pre-existing): Escalated ✅

**Files Changed**:
- `backend/agents/supervisor/supervisor.py` — Major refactor: replaced Strands agent orchestration with explicit 4-phase parallel pipeline using ThreadPoolExecutor
- `backend/infrastructure/lib/agent-stack.ts` — Added deploy timestamp to runtime Description to force container updates

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 4.5.0 | March 13, 2026 | Updated Lesson 32: Parallel pipeline IMPLEMENTED. Replaced Strands agent orchestration with explicit 4-phase parallel pipeline using ThreadPoolExecutor. All 7 scenarios verified correct via AgentCore path. Decision rules aligned between AgentCore and Bedrock direct paths. |
| 4.4.0 | March 13, 2026 | Added Lesson 32: Pipeline performance analysis (214s total). Documented parallelization opportunity with estimated 65% reduction. Verified Lesson 31 fix — STP scenario approved correctly via AgentCore path. |
| 4.3.0 | March 11, 2026 | Added Lesson 31: AgentCore specialist agents lack context — wrong decisions. Supervisor now enriches claim data with policy records and S3 documents before dispatching to specialists. Increased Lambda read_timeout to 600s. |
| 4.2.0 | March 11, 2026 | Added Lesson 30: Cascading AgentCore cold starts in multi-agent pipeline. Updated Lesson 29 with verified fix details. Added warm-up Lambda, increased Lambda timeout, added client read timeout. |
| 4.1.0 | March 11, 2026 | Added Lessons 28-29: AgentCore container crash due to missing AWS_REGION in boto3 calls, SSE stream parsing empty response body. |
| 4.0.0 | March 6, 2026 | Added Lessons 24-27: KMS key race condition, OpenSearch wildcard role rejection, AgentCore ARM64 requirement, API Gateway CloudWatch Logs role for fresh accounts. |
| 3.1.0 | March 6, 2026 | Added Lessons 21-23: AI Claims Assistant chatbot architecture, Processing Flow sidebar placement (adjuster vs claimant), document verification in AI processing. |
| 3.0.0 | March 6, 2026 | Added Lessons 14-20: CORS/Decimal serialization, DynamoDB composite key queries, AgentCore cold start timeout, Bedrock model IDs, frontend field mismatches, Business Dashboard metrics, Adjuster Workbench escalation filter. |
| 2.1.0 | March 5, 2026 | Added Lesson 13: Direct Code Deploy vs Container Deploy for AgentCore. Documented the migration from ECR/CodeBuild to S3-based Direct Code Deploy approach. |
| 2.0.0 | March 5, 2026 | Added 12 lessons learned from actual deployment. Documented OpenSearch race condition, SigV4 signing issues, orphaned resource cleanup, Bedrock KB role in data access policy (Lesson 11), and access policy propagation delay fix with sleep custom resource (Lesson 12). Updated recommended KB stack deployment procedure. |
| 1.0.0 | March 5, 2026 | Initial troubleshooting guide |

---

**Last Updated**: March 13, 2026
**Version**: 4.5.0

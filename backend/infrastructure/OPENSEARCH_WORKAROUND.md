# OpenSearch Serverless Index Creation Workaround

## Problem

OpenSearch Serverless collections have a known race condition where CloudFormation reports the collection as created, but it's not fully ready to accept index creation requests. This causes the Knowledge Base stack deployment to fail with:

```
Failed to create index policy-guidelines-index: 404
```

Even with 180-second waits and retry logic with exponential backoff, the timing is unpredictable.

## Solution: Manual Index Creation

The most reliable approach is to create indices manually after confirming the collection is ACTIVE.

### Step 1: Deploy Stack Without Custom Resource

Edit `lib/infrastructure-stack.ts` and comment out the custom resource section:

```typescript
// Comment out these sections:
// const indexCreatorRole = new iam.Role(this, 'IndexCreatorRole', { ... });
// const indexCreatorFunction = new lambda.Function(this, 'IndexCreatorFunction', { ... });
// const indexCreatorProvider = new cr.Provider(this, 'IndexCreatorProvider', { ... });
// const indexCreator = new cdk.CustomResource(this, 'OpenSearchIndices', { ... });

// Also comment out dependencies:
// policyKB.node.addDependency(indexCreator);
// fraudKB.node.addDependency(indexCreator);
// regulatoryKB.node.addDependency(indexCreator);
```

Deploy the stack:
```bash
cdk deploy LifeInsuranceInfraStack --require-approval never
```

This will create the OpenSearch collection but not the indices.

### Step 2: Wait for Collection to be ACTIVE

Check collection status (repeat every 2 minutes):

```bash
aws opensearchserverless list-collections \
  --query 'collectionSummaries[?name==`life-insurance-kb`].[name,status]' \
  --output table
```

Wait until status shows `ACTIVE`. This can take 10-15 minutes after stack deployment.

### Step 3: Create Indices Manually

Get the collection endpoint:

```bash
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name LifeInsuranceInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`OpenSearchEndpoint`].OutputValue' \
  --output text)

echo "Endpoint: $ENDPOINT"
```

Install required Python library:

```bash
pip3 install requests
```

Run the index creation script:

```bash
python3 create_indices.py $ENDPOINT
```

Expected output:
```
Creating indices on endpoint: abc123.us-east-1.aoss.amazonaws.com
Region: us-east-1

✓ Created index: policy-guidelines-index
✓ Created index: fraud-patterns-index
✓ Created index: regulatory-index

Results: 3/3 indices created successfully

✓ All indices created! You can now deploy the Knowledge Base stack:
  cd backend/infrastructure
  cdk deploy LifeInsuranceInfraStack --require-approval never
```

### Step 4: Redeploy Stack

Now that indices exist, redeploy:

```bash
cdk deploy LifeInsuranceInfraStack --require-approval never
```

The Knowledge Bases will now connect successfully to the existing indices.

## Alternative: Increase Wait Times (Less Reliable)

If you prefer to keep the automated approach, you can try increasing wait times:

1. Edit `lib/knowledge-base-stack.ts`:
```typescript
properties: {
  CollectionEndpoint: collection.attrCollectionEndpoint,
  Indices: JSON.stringify([...]),
  WaitSeconds: 300, // Increase from 180 to 300 (5 minutes)
},
```

2. Edit `lib/opensearch-index-handler.py`:
```python
def create_index_with_retry(endpoint, index_name, max_retries=8):  # Increase retries
    for attempt in range(max_retries):
        try:
            create_index(endpoint, index_name)
            return
        except Exception as e:
            if '404' in str(e) and attempt < max_retries - 1:
                wait_time = 60 * (attempt + 1)  # Longer backoff: 60s, 120s, 180s...
```

However, this is still unreliable because OpenSearch Serverless timing varies.

## Why This Happens

OpenSearch Serverless collections go through multiple internal states:
1. CloudFormation reports CREATE_COMPLETE
2. Collection shows as CREATING
3. Collection shows as ACTIVE
4. Internal endpoints become available (unpredictable timing)
5. Indices can be created

The gap between step 3 and 4 is unpredictable (5-15 minutes), which is why automated waits fail.

## Recommendation

Use the manual approach (Steps 1-4 above) for production deployments. It adds a few manual steps but guarantees success.

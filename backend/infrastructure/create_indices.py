#!/usr/bin/env python3
"""
OpenSearch Serverless Index Creator
Waits for collection to be ACTIVE, then creates vector indices for Bedrock Knowledge Bases.

Prerequisites:
    pip3 install boto3 opensearch-py requests-aws4auth

Usage:
    python3 create_indices.py
"""
import boto3
import sys
import time

try:
    from opensearchpy import OpenSearch, RequestsHttpConnection
    from requests_aws4auth import AWS4Auth
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip3 install opensearch-py requests-aws4auth")
    sys.exit(1)

COLLECTION_NAME = 'life-insurance-kb'
INDICES = ['policy-guidelines-index', 'fraud-patterns-index', 'regulatory-index']
REGION = 'us-east-1'
POLL_INTERVAL = 30  # seconds between status checks
MAX_WAIT = 900      # 15 minutes max wait for collection


def wait_for_collection():
    """Poll until collection is ACTIVE, return endpoint."""
    client = boto3.client('opensearchserverless', region_name=REGION)
    print(f"Waiting for collection '{COLLECTION_NAME}' to become ACTIVE...")
    print(f"Polling every {POLL_INTERVAL}s (max {MAX_WAIT}s)\n")

    elapsed = 0
    while elapsed < MAX_WAIT:
        collections = client.list_collections()['collectionSummaries']
        match = [c for c in collections if c['name'] == COLLECTION_NAME]

        if match:
            status = match[0]['status']
            print(f"  [{elapsed:>3}s] Collection status: {status}")

            if status == 'ACTIVE':
                # Get the endpoint via batch-get
                detail = client.batch_get_collection(ids=[match[0]['id']])
                endpoint = detail['collectionDetails'][0]['collectionEndpoint']
                endpoint = endpoint.replace('https://', '')
                print(f"\n✓ Collection is ACTIVE")
                print(f"  Endpoint: {endpoint}\n")
                return endpoint
        else:
            print(f"  [{elapsed:>3}s] Collection not found yet...")

        time.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL

    print(f"\n✗ Timed out after {MAX_WAIT}s waiting for collection")
    sys.exit(1)


def create_indices(endpoint):
    """Create all vector indices."""
    session = boto3.Session()
    creds = session.get_credentials().get_frozen_credentials()
    awsauth = AWS4Auth(creds.access_key, creds.secret_key, REGION, 'aoss', session_token=creds.token)

    client = OpenSearch(
        hosts=[{'host': endpoint, 'port': 443}],
        http_auth=awsauth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection
    )

    body = {
        'settings': {'index': {'knn': True, 'knn.algo_param.ef_search': 512}},
        'mappings': {'properties': {
            'vector': {
                'type': 'knn_vector', 'dimension': 1024,
                'method': {'name': 'hnsw', 'engine': 'faiss', 'parameters': {'ef_construction': 512, 'm': 16}}
            },
            'text': {'type': 'text'},
            'metadata': {'type': 'text'}
        }}
    }

    success = 0
    for index_name in INDICES:
        try:
            client.indices.create(index=index_name, body=body)
            print(f"✓ Created: {index_name}")
            success += 1
        except Exception as e:
            if 'resource_already_exists' in str(e):
                print(f"✓ Already exists: {index_name}")
                success += 1
            else:
                print(f"✗ Failed: {index_name} - {e}")
        time.sleep(2)

    return success


def main():
    identity = boto3.client('sts').get_caller_identity()['Arn']
    print(f"Identity: {identity}")
    print(f"Region:   {REGION}\n")

    endpoint = wait_for_collection()

    print("Creating indices...")
    success = create_indices(endpoint)

    print(f"\nResults: {success}/{len(INDICES)} indices ready")

    if success == len(INDICES):
        print("\n✓ All done! The CDK deploy should pick these up automatically.")
    else:
        print("\n✗ Some indices failed. Check errors above.")
        sys.exit(1)


if __name__ == '__main__':
    main()

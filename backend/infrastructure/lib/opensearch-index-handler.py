"""
Custom Resource Lambda Handler for OpenSearch Serverless Index Creation
Creates vector indices required for Bedrock Knowledge Bases
"""
import json
import boto3
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

def handler(event, context):
    """
    CloudFormation custom resource handler
    Creates OpenSearch Serverless indices for Bedrock Knowledge Bases
    """
    print(f"Event: {json.dumps(event)}")
    
    try:
        request_type = event['RequestType']
        
        if request_type == 'Delete':
            # Don't delete indices on stack deletion
            return {'PhysicalResourceId': 'opensearch-indices'}
        
        if request_type in ['Create', 'Update']:
            # Get parameters
            collection_endpoint = event['ResourceProperties']['CollectionEndpoint']
            indices = json.loads(event['ResourceProperties']['Indices'])
            wait_seconds = int(event['ResourceProperties'].get('WaitSeconds', 180))
            
            print(f"Collection endpoint: {collection_endpoint}")
            print(f"Indices to create: {indices}")
            print(f"Initial wait time: {wait_seconds} seconds")
            
            # Wait for collection to be fully ready
            print(f"Waiting {wait_seconds} seconds for collection to be ready...")
            time.sleep(wait_seconds)
            
            # Create each index with retry logic
            results = {}
            for index_name in indices:
                create_index_with_retry(collection_endpoint, index_name, max_retries=5)
                results[index_name] = 'Created'
            
            return {
                'PhysicalResourceId': 'opensearch-indices',
                'Data': results
            }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise Exception(f"Failed to create indices: {str(e)}")


def create_index_with_retry(endpoint, index_name, max_retries=8):
    """
    Create index with retry logic for timing issues
    Credentials are refreshed each attempt to avoid SigV4 signature expiry
    """
    for attempt in range(max_retries):
        try:
            create_index(endpoint, index_name)
            print(f"Successfully created index {index_name} on attempt {attempt + 1}")
            return
        except Exception as e:
            if ('404' in str(e) or '403' in str(e)) and attempt < max_retries - 1:
                wait_time = 30 * (attempt + 1)  # Backoff: 30s, 60s, 90s, 120s, 150s, 180s, 210s
                print(f"Attempt {attempt + 1} failed, waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            else:
                raise


def create_index(endpoint, index_name):
    """
    Create a vector index in OpenSearch Serverless
    """
    # Remove https:// prefix if present
    endpoint = endpoint.replace('https://', '')
    
    url = f"https://{endpoint}/{index_name}"
    
    # Index mapping for Bedrock Knowledge Base
    index_body = {
        "settings": {
            "index": {
                "knn": True,
                "knn.algo_param.ef_search": 512
            }
        },
        "mappings": {
            "properties": {
                "vector": {
                    "type": "knn_vector",
                    "dimension": 1024,
                    "method": {
                        "name": "hnsw",
                        "engine": "faiss",
                        "parameters": {
                            "ef_construction": 512,
                            "m": 16
                        }
                    }
                },
                "text": {
                    "type": "text"
                },
                "metadata": {
                    "type": "text"
                }
            }
        }
    }
    
    # Sign the request with AWS SigV4
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    import boto3
    
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    region = session.region_name or 'us-east-1'
    
    body = json.dumps(index_body).encode('utf-8')
    
    request = AWSRequest(
        method='PUT',
        url=url,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Host': endpoint,
        }
    )
    
    SigV4Auth(credentials, 'aoss', region).add_auth(request)
    
    # Make the request using signed headers exactly
    try:
        req = Request(url, data=body, method='PUT')
        for key, val in request.headers.items():
            req.add_header(key, val)
        
        response = urlopen(req)
        result = response.read().decode('utf-8')
        print(f"Created index {index_name}: {result}")
        
    except HTTPError as e:
        error_body = e.read().decode('utf-8')
        if e.code == 400 and 'resource_already_exists' in error_body:
            print(f"Index {index_name} already exists")
            return
        raise Exception(f"Failed to create index {index_name}: {e.code} {error_body}")
    except URLError as e:
        raise Exception(f"Failed to connect to OpenSearch: {str(e)}")

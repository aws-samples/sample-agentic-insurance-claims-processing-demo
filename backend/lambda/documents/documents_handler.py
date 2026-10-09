"""
Documents Handler Lambda
Handles document upload/download operations for claims.
Supports multiple document uploads per request.
"""
import json
import os
import re as _re
import logging
import boto3
import base64
import uuid
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

DOCUMENTS_BUCKET = os.environ['DOCUMENTS_BUCKET']
CLAIMS_TABLE = os.environ['CLAIMS_TABLE']
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

table = dynamodb.Table(CLAIMS_TABLE)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}


def handler(event, context):
    """API Gateway Lambda handler for document operations"""
    try:
        http_method = event.get('httpMethod', '')

        if http_method == 'OPTIONS':
            return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}
        elif http_method == 'POST':
            return upload_documents(event)
        elif http_method == 'GET':
            return list_documents(event)
        else:
            return response(404, {'error': 'Not found'})

    except Exception as e:
        logger.exception("Unhandled error in documents handler")
        return response(500, {'error': 'An internal error occurred. Please try again.'})


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body, default=str),
    }


def _get_user_info(event):
    """Extract user identity and groups from the Cognito authorizer claims."""
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    return {
        'username': claims.get('cognito:username', claims.get('sub', 'unknown')),
        'groups': claims.get('cognito:groups', ''),
    }


def _parse_groups(user_info):
    """Parse the raw Cognito group claim into a set of exact, lowercased names.

    Normalizes the several shapes the `cognito:groups` claim can take (list,
    "[A, B]" string, or comma/space separated) so membership is tested by
    exact match, never substring.
    """
    raw = user_info.get('groups', '')
    if isinstance(raw, (list, tuple, set)):
        tokens = [str(g) for g in raw]
    else:
        cleaned = str(raw).strip().strip('[]')
        tokens = _re.split(r'[,\s]+', cleaned)
    return {t.strip().strip('"\'').lower() for t in tokens if t.strip()}


# Privileged roles that may act across all claims (not just their own).
_PRIVILEGED_GROUPS = {'adjusters', 'businessusers'}


def _is_claimant_only(user_info):
    """True if the caller must be restricted to claims they own.

    Deny-by-default: anyone not explicitly in a privileged group
    (Adjusters/BusinessUsers) is treated as an ordinary claimant, so a
    group-less or unrecognized caller gets the most restrictive treatment
    rather than falling through to privileged access.
    """
    return not bool(_parse_groups(user_info) & _PRIVILEGED_GROUPS)


def _get_claim_owner(claim_id):
    """Return the claimantUsername recorded on a claim, or None if the claim
    does not exist or predates ownership tracking."""
    from boto3.dynamodb.conditions import Key as DDBKey
    result = table.query(
        KeyConditionExpression=DDBKey('claimId').eq(claim_id),
        Limit=1,
    )
    items = result.get('Items', [])
    if not items:
        return None, False  # claim not found
    return items[0].get('claimantUsername'), True  # (owner, exists)


def _authorize_claim_access(event, claim_id):
    """Ownership gate for document operations on a claim.

    Returns an error response to short-circuit with, or None if the caller is
    allowed to proceed. Ordinary Claimants may only touch their own claim's
    documents; a non-owner receives 404 (so a non-owner cannot even confirm
    the claim exists). Adjusters/BusinessUsers are always allowed.
    """
    user_info = _get_user_info(event)
    if not _is_claimant_only(user_info):
        return None  # privileged roles may access any claim's documents

    owner, exists = _get_claim_owner(claim_id)
    if not exists or owner != user_info['username']:
        return response(404, {'error': 'Claim not found'})
    return None


def upload_documents(event):
    """
    Upload one or more documents to S3 for a claim.

    Expects JSON body with either:
    A) Single document:
       { "fileName": "...", "fileContent": "<base64>", "documentType": "death_certificate" }
    B) Multiple documents:
       { "documents": [
           { "fileName": "...", "fileContent": "<base64>", "documentType": "..." },
           ...
         ]
       }
    """
    claim_id = event['pathParameters']['claimId']

    # Ownership gate: an ordinary Claimant may only upload documents to their
    # own claim, so one claimant cannot inject or tamper with another's
    # evidence (which feeds the AI decision).
    auth_err = _authorize_claim_access(event, claim_id)
    if auth_err:
        return auth_err

    body = json.loads(event.get('body', '{}'))

    # Normalize to list
    if 'documents' in body:
        doc_list = body['documents']
    else:
        doc_list = [body]

    if not doc_list:
        return response(400, {'error': 'No documents provided'})

    uploaded = []
    timestamp = datetime.utcnow().isoformat()

    for doc in doc_list:
        file_name = doc.get('fileName')
        file_content = doc.get('fileContent')  # Base64 encoded
        document_type = doc.get('documentType', 'other')

        if not file_name or not file_content:
            continue

        # Document type allowlist
        VALID_DOCUMENT_TYPES = {'death_certificate', 'medical_records', 'beneficiary_id', 'policy_document', 'trust_document', 'other'}
        if document_type not in VALID_DOCUMENT_TYPES:
            document_type = 'other'

        # Path sanitization — strip path separators and dangerous chars
        file_name = _re.sub(r'[/\\\.\.]+', '_', file_name)
        file_name = file_name.strip('._')
        if not file_name:
            file_name = 'unnamed'

        # Decode base64 content
        try:
            file_data = base64.b64decode(file_content)
        except Exception:
            uploaded.append({
                'fileName': file_name,
                'error': 'Invalid base64 content',
            })
            continue

        # Generate unique document ID
        doc_id = str(uuid.uuid4())[:8]
        s3_key = f"{claim_id}/{document_type}/{doc_id}_{file_name}"

        # Upload to S3
        s3.put_object(
            Bucket=DOCUMENTS_BUCKET,
            Key=s3_key,
            Body=file_data,
            Metadata={
                'claimId': claim_id,
                'documentType': document_type,
                'originalFileName': file_name,
                'uploadedAt': timestamp,
            },
        )

        uploaded.append({
            'documentId': doc_id,
            'fileName': file_name,
            'documentType': document_type,
            's3Key': s3_key,
            'size': len(file_data),
            'uploadedAt': timestamp,
        })

    # Update claim record with document references
    if uploaded:
        try:
            # Table has composite key (claimId + timestamp) — must query to get sort key
            from boto3.dynamodb.conditions import Key as DDBKey
            result = table.query(
                KeyConditionExpression=DDBKey('claimId').eq(claim_id),
                Limit=1,
            )
            items = result.get('Items', [])
            if items:
                claim_item = items[0]
                table.update_item(
                    Key={
                        'claimId': claim_id,
                        'timestamp': claim_item['timestamp'],
                    },
                    UpdateExpression='SET documents = list_append(if_not_exists(documents, :empty), :docs), updatedAt = :ts',
                    ExpressionAttributeValues={
                        ':docs': uploaded,
                        ':empty': [],
                        ':ts': int(datetime.utcnow().timestamp() * 1000),
                    },
                )
            else:
                print(f"Warning: Claim {claim_id} not found in DynamoDB, cannot update documents array")
        except Exception as e:
            print(f"Warning: Could not update claim record: {e}")

    return response(201, {
        'message': f'{len(uploaded)} document(s) uploaded',
        'documents': uploaded,
    })


def list_documents(event):
    """List all documents for a claim (owner or privileged roles only)."""
    claim_id = event['pathParameters']['claimId']

    auth_err = _authorize_claim_access(event, claim_id)
    if auth_err:
        return auth_err

    # List objects in S3 with claim_id prefix
    result = s3.list_objects_v2(
        Bucket=DOCUMENTS_BUCKET,
        Prefix=f"{claim_id}/",
    )

    documents = []
    if 'Contents' in result:
        for obj in result['Contents']:
            key = obj['Key']
            parts = key.split('/')
            doc_type = parts[1] if len(parts) > 2 else 'other'
            file_name = parts[-1]

            documents.append({
                'key': key,
                'fileName': file_name,
                'documentType': doc_type,
                'size': obj['Size'],
                'lastModified': obj['LastModified'].isoformat(),
            })

    return response(200, {'documents': documents, 'count': len(documents)})

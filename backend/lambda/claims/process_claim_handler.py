"""
EventBridge Target: Claims AI Processing Handler

Triggered by EventBridge rule when a ClaimSubmitted event is received.
Extracts the claim from DynamoDB, fetches documents, runs AI processing,
and emits lifecycle events for each stage transition.

Replaces the previous Lambda async self-invoke pattern with proper
event-driven architecture.
"""
import json
import os
import time
import boto3
from boto3.dynamodb.conditions import Key
from datetime import datetime
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
events_client = boto3.client('events')
bedrock_runtime = boto3.client('bedrock-runtime', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

CLAIMS_TABLE = os.environ.get('CLAIMS_TABLE', 'LifeInsuranceClaims')
DOCUMENTS_BUCKET = os.environ.get('DOCUMENTS_BUCKET', '')
SUPERVISOR_RUNTIME_ARN = os.environ.get('SUPERVISOR_RUNTIME_ARN', '')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', 'claims-processing-bus')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')

table = dynamodb.Table(CLAIMS_TABLE)


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)


def _emit_event(detail_type: str, claim_id: str, detail: dict) -> None:
    """Emit a claims lifecycle event to EventBridge."""
    try:
        events_client.put_events(
            Entries=[{
                'Source': 'claims.lifecycle',
                'DetailType': detail_type,
                'Detail': json.dumps({
                    'claimId': claim_id,
                    'timestamp': datetime.now().isoformat(),
                    **detail,
                }, cls=DecimalEncoder),
                'EventBusName': EVENT_BUS_NAME,
            }]
        )
        print(f"Emitted event: {detail_type} for {claim_id}")
    except Exception as e:
        print(f"Failed to emit event {detail_type}: {e}")


def _get_claim_item(claim_id: str):
    """Query by partition key only (table has composite key claimId+timestamp)."""
    result = table.query(
        KeyConditionExpression=Key('claimId').eq(claim_id),
        Limit=1,
    )
    items = result.get('Items', [])
    return items[0] if items else None


def _update_claim_status(claim_id: str, timestamp, status: str, extra_fields: dict = None):
    """Update claim status and optional fields in DynamoDB."""
    update_expr = "SET #s = :status, updatedAt = :now"
    expr_values = {
        ':status': status,
        ':now': int(datetime.now().timestamp()),
    }
    expr_names = {'#s': 'status'}

    if extra_fields:
        for key, value in extra_fields.items():
            update_expr += f", {key} = :{key}"
            expr_values[f':{key}'] = value

    table.update_item(
        Key={'claimId': claim_id, 'timestamp': timestamp},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def _fetch_claim_documents(claim_id: str):
    """Fetch all uploaded documents for a claim from S3.

    Returns text content from uploaded documents (text files only).
    PDF/binary files are noted but not processed inline.
    """
    text_documents = []

    try:
        # Check both S3 key patterns (frontend uploads vs test data)
        all_objects = []
        for prefix in [f"{claim_id}/", f"claims/{claim_id}/"]:
            result = s3.list_objects_v2(Bucket=DOCUMENTS_BUCKET, Prefix=prefix)
            if 'Contents' in result:
                all_objects.extend(result['Contents'])

        if not all_objects:
            return None

        for obj in all_objects:
            key = obj['Key']
            if obj['Size'] > 500_000:
                text_documents.append(f"[Document: {key} - {obj['Size']} bytes, too large to process]")
                continue

            try:
                resp = s3.get_object(Bucket=DOCUMENTS_BUCKET, Key=key)
                content = resp['Body'].read()
                parts = key.split('/')
                doc_type = parts[-2] if len(parts) > 2 else 'unknown'
                file_name = parts[-1]

                # Only process text files inline
                try:
                    text = content.decode('utf-8')
                    text_documents.append(
                        f"--- DOCUMENT: {doc_type.upper()} ({file_name}) ---\n{text.strip()}\n--- END DOCUMENT ---"
                    )
                except UnicodeDecodeError:
                    text_documents.append(f"[Document: {doc_type.upper()} ({file_name}) - binary file, {obj['Size']} bytes]")

            except Exception as e:
                text_documents.append(f"[Document: {key} - failed to read: {str(e)[:100]}]")

    except Exception as e:
        print(f"Error fetching documents for {claim_id}: {e}")
        return None

    return text_documents


def _invoke_agentcore_supervisor(claim: dict) -> dict | None:
    """Try processing via AgentCore Supervisor runtime. Returns parsed result or None on failure."""
    runtime_arn = SUPERVISOR_RUNTIME_ARN
    if not runtime_arn:
        print("No SUPERVISOR_RUNTIME_ARN configured, skipping AgentCore")
        return None

    try:
        from botocore.config import Config
        agentcore_config = Config(read_timeout=600, connect_timeout=10)
        agentcore_client = boto3.client('bedrock-agentcore', region_name=os.environ.get('AWS_REGION', 'us-east-1'), config=agentcore_config)
        payload = {
            'prompt': 'Process this death benefits claim.',
            'claim_data': {
                'claimId': claim.get('claimId', ''),
                'policyNumber': claim.get('policyNumber', ''),
                'policyHolderName': claim.get('policyHolderName', ''),
                'beneficiaryName': claim.get('beneficiaryName', ''),
                'relationship': claim.get('relationship', ''),
                'dateOfDeath': claim.get('dateOfDeath', ''),
                'causeOfDeath': claim.get('causeOfDeath', ''),
                'claimAmount': float(claim.get('claimAmount', 0)),
            },
        }

        resp = agentcore_client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            qualifier='DEFAULT',
            payload=json.dumps(payload),
        )

        # Read response
        content_type = resp.get('contentType', '')
        if 'text/event-stream' in content_type:
            raw_chunks = []
            for line in resp['response'].iter_lines(chunk_size=1024):
                if line:
                    decoded = line.decode('utf-8').strip()
                    if decoded.startswith('data: '):
                        raw_chunks.append(decoded[6:])
                    elif decoded and not decoded.startswith('event:'):
                        raw_chunks.append(decoded)
            result_text = ''.join(raw_chunks)
            body = json.loads(result_text) if result_text else {}
        else:
            raw = resp['response'].read().decode('utf-8')
            body = json.loads(raw) if raw else {}

        # Extract and parse the agent's response
        agent_response = body.get('response', '')
        print(f"AgentCore response length: {len(str(agent_response))}")

        result = None
        if isinstance(agent_response, dict):
            result = agent_response
        elif isinstance(agent_response, str):
            text = agent_response.strip()
            try:
                result = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                pass
            if result is None and '```json' in text:
                try:
                    result = json.loads(text.split('```json')[1].split('```')[0].strip())
                except (json.JSONDecodeError, ValueError, IndexError):
                    pass
            if result is None:
                start = text.find('{')
                if start != -1:
                    depth = 0
                    for i in range(start, len(text)):
                        if text[i] == '{':
                            depth += 1
                        elif text[i] == '}':
                            depth -= 1
                            if depth == 0:
                                try:
                                    result = json.loads(text[start:i + 1])
                                except (json.JSONDecodeError, ValueError):
                                    pass
                                break

        if result and isinstance(result, dict) and 'decision' in result:
            print(f"AgentCore Supervisor returned decision: {result['decision']}")
            result['processing_path'] = 'agentcore'
            return result

        print("AgentCore response did not contain a valid decision JSON")
        return None

    except Exception as e:
        print(f"AgentCore invocation failed: {str(e)[:200]}. Falling back to direct Bedrock.")
        return None


def _process_with_bedrock(claim: dict, documents: list) -> dict:
    """Process claim using Bedrock InvokeModel with Claude Sonnet 4 (text-only)."""
    from claims_handler import PROCESSING_PROMPT, POLICY_DATABASE

    policy_number = claim.get('policyNumber', '')
    policy_record = POLICY_DATABASE.get(policy_number, {})
    policy_record_text = json.dumps(policy_record, indent=2) if policy_record else "NO MATCHING POLICY FOUND"

    documents_section = "\n\n".join(documents) if documents else "NO DOCUMENTS SUBMITTED"

    prompt = PROCESSING_PROMPT.format(
        claimId=claim.get('claimId', ''),
        policyNumber=policy_number,
        policyHolderName=claim.get('policyHolderName', ''),
        beneficiaryName=claim.get('beneficiaryName', ''),
        relationship=claim.get('relationship', ''),
        dateOfDeath=claim.get('dateOfDeath', ''),
        causeOfDeath=claim.get('causeOfDeath', ''),
        claimAmount=float(claim.get('claimAmount', 0)),
        policyRecord=policy_record_text,
        documentsSection=documents_section,
    )

    guardrail_id = os.environ.get('GUARDRAIL_ID', '')
    guardrail_version = os.environ.get('GUARDRAIL_VERSION', 'DRAFT')

    invoke_params = {
        'modelId': MODEL_ID,
        'contentType': 'application/json',
        'accept': 'application/json',
        'body': json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 2048,
            'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0.1,
        }),
    }
    if guardrail_id:
        invoke_params['guardrailIdentifier'] = guardrail_id
        invoke_params['guardrailVersion'] = guardrail_version

    response = bedrock_runtime.invoke_model(**invoke_params)

    response_body = json.loads(response['body'].read())
    ai_text = response_body.get('content', [{}])[0].get('text', '{}')

    # Parse AI response
    try:
        import re
        json_match = re.search(r'\{[\s\S]*\}', ai_text)
        if json_match:
            return json.loads(json_match.group())
    except (json.JSONDecodeError, AttributeError):
        pass

    return {'decision': 'escalated', 'reasoning': 'Failed to parse AI response', 'confidence': 0.0, 'fraud_score': 0.5}


def handler(event, context):
    """EventBridge target handler for claims AI processing.

    Handles both ClaimSubmitted and ClaimResubmitted events.
    For resubmissions, includes previous decision context in the AI prompt.
    """
    print(f"Processing EventBridge event: {json.dumps(event, default=str)[:500]}")

    # Determine event type
    detail_type = event.get('detail-type', event.get('DetailType', 'ClaimSubmitted'))
    is_resubmission = 'Resubmit' in detail_type

    # Extract claim details from EventBridge event
    detail = event.get('detail', {})
    claim_id = detail.get('claimId')
    claim_timestamp = detail.get('claimTimestamp')

    if not claim_id:
        print("ERROR: No claimId in event detail")
        return {'statusCode': 400, 'error': 'Missing claimId'}

    print(f"Processing {'resubmission' if is_resubmission else 'new claim'}: {claim_id}")

    # Fetch the claim from DynamoDB
    claim = _get_claim_item(claim_id)
    if not claim:
        print(f"ERROR: Claim {claim_id} not found in DynamoDB")
        return {'statusCode': 404, 'error': f'Claim {claim_id} not found'}

    timestamp = claim.get('timestamp')

    # Emit: ClaimProcessing event
    _emit_event('ClaimProcessing', claim_id, {
        'stage': 'ai_processing_started',
        'isResubmission': is_resubmission,
    })

    # Update status to processing
    _update_claim_status(claim_id, timestamp, 'processing')

    # Wait for document uploads to complete (brief window)
    print(f"Waiting 5s for documents to be uploaded for {claim_id}")
    time.sleep(5)

    # Fetch documents
    text_documents = _fetch_claim_documents(claim_id)

    # --- Deterministic Document Completeness Check ---
    # Before calling the AI, verify required document TYPES are present in S3.
    # This prevents the AI from hallucinating documents or approving without them.
    required_doc_types = {'death_certificate', 'medical_records', 'beneficiary_id'}
    found_doc_types = set()

    # Check S3 for document type folders
    try:
        for prefix in [f"{claim_id}/", f"claims/{claim_id}/"]:
            result = s3.list_objects_v2(Bucket=DOCUMENTS_BUCKET, Prefix=prefix)
            for obj in result.get('Contents', []):
                key = obj['Key'].lower()
                if 'death_certificate' in key or 'death-certificate' in key or 'deathcertificate' in key:
                    found_doc_types.add('death_certificate')
                elif 'medical_record' in key or 'medical-record' in key or 'medicalrecord' in key:
                    found_doc_types.add('medical_records')
                elif 'beneficiary_id' in key or 'beneficiary-id' in key or 'beneficiaryid' in key:
                    found_doc_types.add('beneficiary_id')
    except Exception as e:
        print(f"Document type check failed: {e}")

    missing_docs = required_doc_types - found_doc_types
    print(f"Document check for {claim_id}: found={found_doc_types}, missing={missing_docs}")

    if missing_docs:
        # Escalate immediately — don't even call the AI
        missing_names = []
        if 'death_certificate' in missing_docs:
            missing_names.append('Death Certificate')
        if 'medical_records' in missing_docs:
            missing_names.append('Medical Records')
        if 'beneficiary_id' in missing_docs:
            missing_names.append('Beneficiary ID')

        escalation_reason = f"Missing required documents: {', '.join(missing_names)}. All three documents (Death Certificate, Medical Records, Beneficiary ID) must be submitted for claim processing."

        _update_claim_status(claim_id, timestamp, 'escalated', {
            'processingDetails': json.dumps({
                'decision': 'escalated',
                'reasoning': escalation_reason,
                'confidence': 1.0,
                'fraud_score': 0.0,
                'documents_verified': False,
                'document_findings': f"Missing: {', '.join(missing_names)}. Found: {', '.join(found_doc_types) or 'none'}.",
            }),
            'aiDecision': 'escalated',
            'aiConfidence': Decimal('1.0'),
            'fraudScore': Decimal('0.0'),
            'processedAt': int(datetime.now().timestamp()),
        })

        _emit_event('ClaimEscalated', claim_id, {
            'decision': 'escalated',
            'reasoning': escalation_reason,
            'missingDocuments': list(missing_docs),
        })

        print(f"Claim {claim_id} escalated: missing documents {missing_docs}")
        return {'statusCode': 200, 'claimId': claim_id, 'decision': 'escalated', 'missingDocuments': list(missing_docs)}

    # Emit: DocumentsVerified event
    doc_count = len(text_documents) if text_documents else 0
    _emit_event('ClaimDocumentsVerified', claim_id, {
        'stage': 'documents_verified',
        'documentCount': doc_count,
    })

    # Process with AI — AgentCore Supervisor (primary) → Bedrock InvokeModel (fallback)
    print(f"Processing claim {claim_id} ({doc_count} text documents)")
    try:
        # Try AgentCore Supervisor first
        ai_result = _invoke_agentcore_supervisor(claim)
        if not ai_result:
            # Fallback to direct Bedrock InvokeModel
            print(f"Falling back to direct Bedrock InvokeModel for {claim_id}")
            ai_result = _process_with_bedrock(claim, text_documents or [])
            ai_result['processing_path'] = 'bedrock_direct'
    except Exception as e:
        print(f"AI processing failed for {claim_id}: {e}")
        _update_claim_status(claim_id, timestamp, 'error', {
            'processingDetails': json.dumps({'error': str(e)[:500]}),
        })
        _emit_event('ClaimProcessingFailed', claim_id, {'error': str(e)[:200]})
        return {'statusCode': 500, 'error': str(e)}

    # Extract decision
    decision = ai_result.get('decision', 'escalated')
    confidence = ai_result.get('confidence', 0.0)
    fraud_score = ai_result.get('fraud_score', 0.0)
    reasoning = ai_result.get('reasoning', '')

    # Map decision to final status
    status_map = {
        'approved': 'approved',
        'denied': 'denied',
        'escalated': 'escalated',
    }
    final_status = status_map.get(decision, 'escalated')

    # Update claim with AI results
    processing_details = json.dumps(ai_result, cls=DecimalEncoder)
    _update_claim_status(claim_id, timestamp, final_status, {
        'processingDetails': processing_details,
        'aiDecision': decision,
        'aiConfidence': Decimal(str(round(confidence, 4))),
        'fraudScore': Decimal(str(round(fraud_score, 4))),
        'processedAt': int(datetime.now().timestamp()),
    })

    # Emit: ClaimDecisionMade event
    _emit_event('ClaimDecisionMade', claim_id, {
        'stage': 'decision_made',
        'decision': decision,
        'confidence': confidence,
        'fraudScore': fraud_score,
    })

    # Emit terminal state event
    terminal_event_map = {
        'approved': 'ClaimApproved',
        'denied': 'ClaimDenied',
        'escalated': 'ClaimEscalated',
    }
    _emit_event(terminal_event_map.get(decision, 'ClaimEscalated'), claim_id, {
        'decision': decision,
        'reasoning': reasoning[:500],
        'confidence': confidence,
        'fraudScore': fraud_score,
    })

    print(f"Claim {claim_id} processed: {decision} (confidence: {confidence}, fraud: {fraud_score})")

    return {
        'statusCode': 200,
        'claimId': claim_id,
        'decision': decision,
        'confidence': confidence,
    }

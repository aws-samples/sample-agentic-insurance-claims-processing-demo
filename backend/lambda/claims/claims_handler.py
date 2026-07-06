"""
Claims Handler Lambda
Handles CRUD operations for claims via API Gateway.
AI processing is triggered via Amazon EventBridge events
(handled by process_claim_handler.py).
"""
import json
import os
import re
import logging
import boto3
from boto3.dynamodb.conditions import Key
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')

CLAIMS_TABLE = os.environ['CLAIMS_TABLE']
DOCUMENTS_BUCKET = os.environ['DOCUMENTS_BUCKET']
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

table = dynamodb.Table(CLAIMS_TABLE)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
}

# ── Injection detection patterns (shared across create/resubmit) ──────
_INJECTION_PATTERNS = [
    r'ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|context)',
    r'you\s+are\s+now\s+(a|an|the)\s+',
    r'<\s*system\s*>|<<\s*SYS\s*>>|\[INST\]',
    r'(forget|disregard|override)\s+(everything|all|your)\s+(above|previous|instructions|rules)',
    r'(\bDAN\b|do\s+anything\s+now|jailbreak|bypass\s+(safety|guardrail|filter))',
]


def _get_user_info(event):
    """Extract user identity and groups from Cognito authorizer."""
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    return {
        'username': claims.get('cognito:username', claims.get('sub', 'unknown')),
        'email': claims.get('email', ''),
        'groups': claims.get('cognito:groups', ''),
    }


def _require_group(event, allowed_groups):
    """Check if user belongs to one of the allowed groups. Returns error response or None."""
    user_info = _get_user_info(event)
    user_groups = user_info.get('groups', '')
    # Groups come as a string like "[Adjusters]" or comma-separated
    for group in allowed_groups:
        if group.lower() in user_groups.lower():
            return None  # Authorized
    return response(403, {'error': 'Forbidden: insufficient permissions'})


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def _get_claim_item(claim_id):
    """Query by partition key only (table has composite key claimId+timestamp)."""
    result = table.query(
        KeyConditionExpression=Key('claimId').eq(claim_id),
        Limit=1,
    )
    items = result.get('Items', [])
    return items[0] if items else None


# ── AI Claims Processing via Bedrock InvokeModel ──────────────────────

# Simulated policy database — in production this would be a DB/KB lookup
POLICY_DATABASE = {
    'LIP-2019-087234': {
        'status': 'ACTIVE', 'holder': 'Robert James Mitchell',
        'beneficiary': 'Margaret Anne Mitchell', 'relationship': 'Spouse',
        'face_amount': 250000, 'effective_date': '2019-06-15',
        'premiums_current': True, 'last_premium': '2026-03-01',
        'contestability_expired': True,
        'notes': 'Policy in good standing since 2019. No exclusions on file. Premiums current. Contestability period expired June 2021.',
    },
    'LIP-2018-054891': {
        'status': 'LAPSED', 'holder': 'Thomas Edward Parker',
        'beneficiary': 'Jennifer Parker', 'relationship': 'Ex-Spouse',
        'face_amount': 200000, 'effective_date': '2018-03-01',
        'premiums_current': False, 'last_premium': '2025-07-01',
        'contestability_expired': True,
        'notes': 'POLICY LAPSED September 1, 2025. Last premium July 2025. Grace period ended August 31, 2025. Three lapse notices sent. Reinstatement not eligible. Beneficiary is ex-spouse (divorce April 2024, designation never updated). NO COVERAGE IN FORCE AT TIME OF DEATH.',
    },
    'LIP-2025-112847': {
        'status': 'ACTIVE', 'holder': 'Victor Alejandro Reyes',
        'beneficiary': 'Maria Elena Reyes', 'relationship': 'Spouse',
        'face_amount': 500000, 'effective_date': '2025-12-01',
        'premiums_current': True, 'last_premium': '2026-02-01',
        'contestability_expired': False,
        'notes': 'HIGH RISK: Policy purchased only 83 days before death. Previous $50K policy cancelled and replaced with $500K (10x increase). Beneficiary changed 45 days before death. Within contestability. Accidental drowning with BAC 0.18. Family declined autopsy.',
    },
    'LIP-2015-023456': {
        'status': 'ACTIVE', 'holder': 'Elizabeth Grace Thornton',
        'beneficiary': 'Thornton Family Trust (60%) / Catherine Thornton-Wells (40%)',
        'relationship': 'Trust/Daughter', 'face_amount': 750000,
        'effective_date': '2015-04-01', 'premiums_current': True,
        'last_premium': '2026-02-01', 'contestability_expired': True,
        'notes': 'Long-standing policy (11 years). Clean history. Natural cause. Claim $150K exceeds $50K threshold requiring senior adjuster review.',
    },
    'LIP-2021-078345': {
        'status': 'ACTIVE', 'holder': 'Andrew Paul Kowalski',
        'beneficiary': 'Susan Marie Kowalski', 'relationship': 'Spouse',
        'face_amount': 300000, 'effective_date': '2021-09-01',
        'premiums_current': True, 'last_premium': '2026-02-01',
        'contestability_expired': True,
        'notes': 'Policy in good standing. HOWEVER: No supporting documents submitted. Cause of death unverified. Cannot process without death certificate.',
    },
    'LIP-2025-098712': {
        'status': 'ACTIVE', 'holder': 'Daniel James Crawford',
        'beneficiary': 'Karen Crawford', 'relationship': 'Mother',
        'face_amount': 200000, 'effective_date': '2025-08-01',
        'premiums_current': True, 'last_premium': '2026-02-01',
        'contestability_expired': False,
        'notes': 'SUICIDE EXCLUSION: Policy only 198 days old. Within 2-year contestability. Cause is suicide. Per Section 4.2, liability limited to premium refund ($1,015). Also undisclosed Major Depressive Disorder — material misrepresentation.',
    },
    'LIP-2023-065478': {
        'status': 'ACTIVE', 'holder': 'William Henry Foster',
        'beneficiary': 'Linda Foster (50%) / Mark Foster (50%)',
        'relationship': 'Spouse/Son', 'face_amount': 175000,
        'effective_date': '2023-01-15', 'premiums_current': True,
        'last_premium': '2026-02-01', 'contestability_expired': True,
        'notes': 'MODERATE RISK: Contestability expired so cannot rescind. But COPD and CHF diagnosed BEFORE application were NOT disclosed. Cause of death related to undisclosed conditions. Beneficiary split changed 3 months before death. Recommend human review.',
    },
    'LIP-2020-041589': {
        'status': 'ACTIVE', 'holder': 'James Richard O\'Brien',
        'beneficiary': 'Patricia O\'Brien',
        'relationship': 'Spouse', 'face_amount': 300000,
        'effective_date': '2020-03-15', 'premiums_current': True,
        'last_premium': '2026-02-01', 'contestability_expired': True,
        'notes': 'BENEFICIARY MISMATCH SCENARIO: Designated beneficiary is Patricia O\'Brien (Spouse). Claimant is Michael O\'Brien (Son). Policy is clean — active, premiums current, contestability expired, natural cause of death. However, the person filing is NOT the designated beneficiary. Requires verification of legal standing before payout.',
    },
    'LIP-2022-034567': {
        'status': 'ACTIVE', 'holder': 'Samuel Thomas Rivera',
        'beneficiary': 'Elena Rivera', 'relationship': 'Spouse',
        'face_amount': 200000, 'effective_date': '2022-04-01',
        'premiums_current': False, 'last_premium': '2026-06-01',
        'contestability_expired': True,
        'notes': 'GRACE PERIOD SCENARIO: Last premium paid June 1, 2026. Premium due July 1, 2026 was NOT paid. Death occurred July 18, 2026 — within 31-day grace period. Per Section 3.1, policy remains in force during grace period. Coverage is active. Premiums current through grace period. No exclusions. Clean history since 2022.',
    },
    'LIP-2017-089012': {
        'status': 'ACTIVE', 'holder': 'Marcus Anthony Walsh',
        'beneficiary': 'Rebecca Walsh', 'relationship': 'Spouse',
        'face_amount': 350000, 'effective_date': '2017-09-15',
        'premiums_current': True, 'last_premium': '2026-06-01',
        'contestability_expired': True,
        'notes': 'WAR/TERRORISM EXCLUSION: Policy Section 5.3 explicitly excludes death resulting from "act of war, declared or undeclared, military service in combat zone, or act of terrorism as defined by US federal law." Policy is otherwise clean — active since 2017, 9 years, premiums current, no other issues. The exclusion clause is the only concern.',
    },
}

PROCESSING_PROMPT = """You are an AI claims processing system for CCOE Insurance Industry LLC.
Analyze this death benefits claim against the policy database record AND the submitted documents.

CLAIM DATA:
- Claim ID: {claimId}
- Policy Number: {policyNumber}
- Policy Holder (Deceased): {policyHolderName}
- Beneficiary: {beneficiaryName}
- Relationship: {relationship}
- Date of Death: {dateOfDeath}
- Cause of Death: {causeOfDeath}
- Claim Amount: ${claimAmount:,.2f}

POLICY DATABASE RECORD:
{policyRecord}

SUBMITTED DOCUMENTS:
{documentsSection}

DOCUMENT VERIFICATION INSTRUCTIONS:
REQUIRED DOCUMENTS for claim approval (ALL must be present):
  1. Death Certificate — official certificate with decedent name, date/cause of death, certifier
  2. Beneficiary ID — government-issued photo identification of the claimant
  3. Medical Records — supporting the stated cause of death (ALWAYS required, no exceptions)

OPTIONAL but strengthening documents:
  4. Policy Document — original policy or policy number confirmation
  5. Trust/Legal Documents — if beneficiary is a trust or estate

VERIFICATION STEPS:
- First, LIST which of the required documents (1-3) are present in the SUBMITTED DOCUMENTS section above
- If a required document shows as "[PDF Document: ... sent for multimodal vision analysis]" that COUNTS as present
- If a required document is MISSING entirely (not listed at all), the claim CANNOT be auto-approved
- Cross-reference the death certificate against the claim form: verify name, date of death, cause of death match
- Verify the beneficiary ID matches the named beneficiary on the policy
- Check medical records for consistency with stated cause of death
- Look for red flags: inconsistent dates, mismatched names, missing certifier info
- In your response, set "documents_verified" to true ONLY if all 3 required documents are present
- In "document_findings", explicitly state which documents were found and which are missing

STRICT DECISION RULES (follow in EXACT order — stop at the FIRST matching rule):
1. LAPSED policy → DENY. No coverage in force.
2. Suicide within 2-year contestability → DENY citing exclusion clause.
3. Fraud score >= 0.7 (requires MULTIPLE red flags: suspicious timing + huge coverage increase + recent beneficiary change + declined autopsy) → DENY.
4. BENEFICIARY MISMATCH — If the claimant (beneficiaryName) does NOT match the designated beneficiary in the policy record:
   a. If claimant is a family member (child, parent, sibling) but NOT the designated beneficiary → ESCALATE. Reasoning: "Claimant is not the designated beneficiary. Verify legal standing (executor, power of attorney, court order)."
   b. If claimant is a Trust and the policy beneficiary field contains the same trust name → PROCEED (treat as match).
   c. If claimant claims to be estate representative → ESCALATE. Reasoning: "Filed by estate representative. Requires proof of executor/administrator appointment."
   d. If relationship is 'other' and no legal documentation present → ESCALATE. Reasoning: "Claimant relationship does not match beneficiary designation."
   NOTE: A spouse filing when spouse is the designated beneficiary is a MATCH — do not flag.
5. Missing critical documents (any of: death certificate, beneficiary ID, or medical records NOT present in submitted documents) → ESCALATE as pending documents. List exactly which documents are missing.
6. Fraud score 0.5-0.7 → ESCALATE to human review.
7. Claim amount >= $100,000 → ESCALATE to human review.
8. Policy ACTIVE + premiums current + contestability expired + fraud < 0.3 + amount < $100,000 + ALL required documents present and verified (documents_verified = true) + beneficiary matches → APPROVE.
9. If none of the above match → ESCALATE for human review.

CRITICAL CLARIFICATIONS (READ CAREFULLY):
- GRACE PERIOD: If the policy notes say "last premium" was within 31 days before the date of death, the policy is STILL IN FORCE even if premiums appear overdue. Do NOT treat this as lapsed.
- SIMULTANEOUS DEATH: If the death certificate indicates the beneficiary also died in the same incident (common disaster), escalate for contingent beneficiary determination.
- WAR/TERRORISM: If cause of death indicates military action, terrorism, or armed conflict, check policy exclusions. If exclusion applies, deny — but the reasoning MUST be written with empathy and respect for the service member's sacrifice. Acknowledge the loss, express condolences, explain the specific policy section that applies, and recommend the beneficiary contact their Servicemembers Group Life Insurance (SGLI) representative or the VA for alternative benefits they may be entitled to. Never use cold or dismissive language for military deaths.
- DOCUMENT VERIFICATION IS MANDATORY: If the SUBMITTED DOCUMENTS section above says "NO DOCUMENTS SUBMITTED" or does not contain actual document text (lines starting with "--- DOCUMENT:"), then documents_verified MUST be false and the claim CANNOT be approved. Do NOT hallucinate or invent document content. Only reference documents that are explicitly shown in the SUBMITTED DOCUMENTS section above.
- A claim amount LESS than the policy face amount is COMPLETELY NORMAL and expected. Beneficiaries routinely claim partial amounts (e.g., $25,000 on a $250,000 policy). This is NOT suspicious, NOT a red flag, and must NOT increase the fraud score.
- The ratio of claim amount to face amount is IRRELEVANT for fraud detection. Do NOT consider it.
- For fraud scoring, ONLY consider these factors: policy age/timing relative to death, recent beneficiary changes, coverage amount increases shortly before death, declined autopsy, inconsistent documents, and contestability period issues.
- A long-standing policy (years old) with current premiums, expired contestability, natural cause of death, ALL required documents verified present, and a claim under $100K is a TEXTBOOK auto-approval. Assign fraud_score 0.0-0.1 and decision "approved". But ONLY if all 3 required documents are actually present in the SUBMITTED DOCUMENTS section.
- Do NOT invent concerns that are not supported by the data. If the policy record says "No exclusions" and "Policy in good standing", take that at face value.
- Do NOT invent documents that are not present. If a document is not shown in SUBMITTED DOCUMENTS, it is NOT present regardless of what the policy notes say.

COMMUNICATION TONE (for the "reasoning" field — this is shown directly to the bereaved family):
- ALWAYS write with empathy and compassion. The claimant has lost a family member. Acknowledge their loss.
- For APPROVALS: Express condolences, confirm the claim is approved, and note next steps warmly.
- For ESCALATIONS: Be reassuring — explain that the claim needs additional review, that this is routine, and no immediate action is needed unless they are contacted.
- For DENIALS (non-fraud): Lead with condolences. Explain the specific policy limitation clearly but gently. Suggest alternatives or next steps where possible.
- For DENIALS (fraud-related, score >= 0.7): Be professional and factual. Cite the specific concerns found. Do not express sympathy for fraudulent claims.
- For MILITARY/COMBAT deaths: Use heightened empathy. Honor the service member's sacrifice. Reference SGLI, VA benefits, and Casualty Assistance Officer as alternative support.
- NEVER use cold, clinical, or bureaucratic language when addressing a grieving family.

Respond ONLY with this JSON (no other text):
{{
  "decision": "approved" or "denied" or "escalated",
  "confidence": 0.0 to 1.0,
  "reasoning": "Detailed explanation citing specific policy facts and document verification findings",
  "fraud_score": 0.0 to 1.0,
  "policy_valid": true or false,
  "authentication_passed": true or false,
  "documents_verified": true or false,
  "document_findings": "Summary of document verification results",
  "processing_steps": ["step1", "step2", ...]
}}"""




# NOTE: AI claim processing (AgentCore Supervisor + Bedrock fallback) is handled by
# process_claim_handler.py, triggered via Amazon EventBridge. The functions previously
# here (_fetch_claim_documents, _invoke_agentcore_supervisor, _process_claim_with_bedrock,
# _process_claim_with_ai, _async_process_claim) have been removed as they are no longer
# invoked from this handler.


# ── Main Handler + CRUD Operations ────────────────────────────────────

def handler(event, context):
    """API Gateway Lambda handler for claims operations"""
    try:
        http_method = event.get('httpMethod', '')
        path = event.get('path', '')

        if http_method == 'OPTIONS':
            return response(200, {})
        elif http_method == 'POST' and path == '/claims':
            return create_claim(event)
        elif http_method == 'GET' and path == '/claims':
            return list_claims(event)
        elif http_method == 'GET' and '/claims/' in path and 'approve' not in path and 'deny' not in path and 'documents' not in path:
            return get_claim(event)
        elif http_method == 'PUT' and '/claims/' in path:
            return update_claim(event)
        elif http_method == 'POST' and 'resubmit' in path:
            return resubmit_claim(event)
        elif http_method == 'POST' and path == '/reset':
            return reset_demo(event)
        elif http_method == 'POST' and 'approve' in path:
            return approve_claim(event)
        elif http_method == 'POST' and 'deny' in path:
            return deny_claim(event)
        else:
            return response(404, {'error': 'Not found'})

    except Exception as e:
        logger.exception("Unhandled error in claims handler")
        return response(500, {'error': 'An internal error occurred. Please try again.'})


def create_claim(event):
    """Create a new claim and trigger async AI processing."""
    body = json.loads(event['body'])

    # --- Input Validation (BSC AWS-3) ---
    required_fields = ['policyNumber', 'policyHolderName', 'beneficiaryName',
                       'relationship', 'dateOfDeath', 'causeOfDeath', 'claimAmount']
    missing = [f for f in required_fields if not body.get(f)]
    if missing:
        return response(400, {'error': f'Missing required fields: {", ".join(missing)}'})

    # Field length limits
    _MAX_STR_LEN = 256
    _MAX_CAUSE_LEN = 500
    for field in ['policyNumber', 'policyHolderName', 'beneficiaryName', 'relationship', 'dateOfDeath']:
        val = body.get(field, '')
        if not isinstance(val, str) or len(val) > _MAX_STR_LEN:
            return response(400, {'error': f"Field '{field}' must be a string under {_MAX_STR_LEN} characters"})

    cause = body.get('causeOfDeath', '')
    if not isinstance(cause, str) or len(cause) > _MAX_CAUSE_LEN:
        return response(400, {'error': f"Field 'causeOfDeath' must be a string under {_MAX_CAUSE_LEN} characters"})

    # Claim amount validation
    try:
        claim_amount = int(body.get('claimAmount', 0))
        if claim_amount <= 0 or claim_amount > 10_000_000:
            return response(400, {'error': 'claimAmount must be between 1 and 10,000,000'})
    except (ValueError, TypeError):
        return response(400, {'error': 'claimAmount must be a valid number'})

    # Prompt injection detection — scan free-text fields
    for field in ['policyHolderName', 'beneficiaryName', 'causeOfDeath', 'relationship']:
        val = body.get(field, '')
        for pattern in _INJECTION_PATTERNS:
            if re.search(pattern, val, re.IGNORECASE):
                print(f"Prompt injection blocked in field '{field}'")
                return response(400, {'error': 'Request rejected: input contains disallowed patterns'})

    claim_id = f"CLM-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    now = int(datetime.now().timestamp())

    claim = {
        'claimId': claim_id,
        'timestamp': now,
        'status': 'submitted',
        'submittedAt': now,
        'updatedAt': now,
        'policyNumber': body.get('policyNumber', ''),
        'policyHolderName': body.get('policyHolderName', ''),
        'beneficiaryName': body.get('beneficiaryName', ''),
        'relationship': body.get('relationship', ''),
        'dateOfDeath': body.get('dateOfDeath', ''),
        'causeOfDeath': body.get('causeOfDeath', ''),
        'claimAmount': int(body.get('claimAmount', 0)),
        'documents': [],
    }

    table.put_item(Item=claim)

    # Emit EventBridge event to trigger async AI processing
    try:
        events_client = boto3.client('events')
        event_bus = os.environ.get('EVENT_BUS_NAME', 'claims-processing-bus')
        events_client.put_events(
            Entries=[{
                'Source': 'claims.lifecycle',
                'DetailType': 'ClaimSubmitted',
                'Detail': json.dumps({
                    'claimId': claim_id,
                    'claimTimestamp': now,
                    'policyNumber': body.get('policyNumber', ''),
                    'claimAmount': int(body.get('claimAmount', 0)),
                }),
                'EventBusName': event_bus,
            }]
        )
        print(f"EventBridge event emitted: ClaimSubmitted for {claim_id}")
    except Exception as e:
        print(f"Failed to emit EventBridge event: {str(e)}")
        # Fallback: self-invoke for backward compatibility
        try:
            lambda_client = boto3.client('lambda')
            lambda_client.invoke(
                FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', ''),
                InvocationType='Event',
                Payload=json.dumps({
                    '_async_process': True,
                    'claimId': claim_id,
                    'claimTimestamp': now,
                }),
            )
            print(f"Fallback: self-invoke triggered for {claim_id}")
        except Exception as fallback_err:
            print(f"Fallback self-invoke also failed: {fallback_err}")

    return response(201, claim)


def list_claims(event):
    """List all claims"""
    result = table.scan()
    items = result.get('Items', [])
    items.sort(key=lambda x: x.get('submittedAt', 0), reverse=True)
    return response(200, items)


def get_claim(event):
    """Get a specific claim by ID with role-based field filtering."""
    claim_id = event['pathParameters']['claimId']
    item = _get_claim_item(claim_id)
    if not item:
        return response(404, {'error': 'Claim not found'})

    # Role-based response filtering: hide sensitive AI fields from Claimants
    user_info = _get_user_info(event)
    user_groups = user_info.get('groups', '').lower()
    if 'claimants' in user_groups and 'adjusters' not in user_groups and 'businessusers' not in user_groups:
        # Extract claimant-safe info before removing sensitive fields
        missing_docs = None
        try:
            details = item.get('processingDetails', '')
            if details:
                parsed = json.loads(details) if isinstance(details, str) else details
                doc_findings = parsed.get('document_findings', '')
                if 'missing' in doc_findings.lower():
                    missing_docs = doc_findings
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass

        sensitive_fields = ['processingDetails', 'fraudScore', 'aiDecision', 'aiConfidence']
        item = {k: v for k, v in item.items() if k not in sensitive_fields}

        # Provide claimant-safe document status
        if missing_docs:
            item['documentStatus'] = missing_docs

    return response(200, item)


def update_claim(event):
    """Update a claim with field allowlist, role check, state validation, and audit."""
    # Role check — only Claimants and Adjusters can update
    auth_err = _require_group(event, ['Claimants', 'Adjusters'])
    if auth_err:
        return auth_err

    claim_id = event['pathParameters']['claimId']
    body = json.loads(event['body'])
    now = int(datetime.now().timestamp())

    item = _get_claim_item(claim_id)
    if not item:
        return response(404, {'error': 'Claim not found'})

    # Block updates on terminal states
    if item.get('status') in ('approved', 'denied'):
        return response(400, {'error': 'Cannot update claims in terminal state (approved/denied)'})

    # Field allowlist — only these fields can be updated
    ALLOWED_UPDATE_FIELDS = {'causeOfDeath', 'relationship', 'additionalNotes', 'notes'}

    update_expr = 'SET updatedAt = :ts'
    expr_values = {':ts': now}
    expr_names = {}

    for key, value in body.items():
        if key in ('claimId', 'timestamp'):
            continue
        if key not in ALLOWED_UPDATE_FIELDS:
            return response(400, {'error': f'Field {key} cannot be updated'})
        # Injection scanning on text fields
        if isinstance(value, str):
            for pattern in _INJECTION_PATTERNS:
                if re.search(pattern, value, re.IGNORECASE):
                    return response(400, {'error': 'Request rejected: input contains disallowed patterns'})
        update_expr += f', #{key} = :{key}'
        expr_values[f':{key}'] = value
        expr_names[f'#{key}'] = key

    # Add audit field
    user_info = _get_user_info(event)
    update_expr += ', actionBy = :actionBy'
    expr_values[':actionBy'] = user_info['username']

    kwargs = {
        'Key': {'claimId': claim_id, 'timestamp': item['timestamp']},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        kwargs['ExpressionAttributeNames'] = expr_names

    table.update_item(**kwargs)
    return response(200, {'message': 'Claim updated', 'claimId': claim_id})


def approve_claim(event):
    """Approve a claim (adjuster only) with role check, state validation, and audit."""
    auth_err = _require_group(event, ['Adjusters'])
    if auth_err:
        return auth_err

    claim_id = event['pathParameters']['claimId']
    body = json.loads(event.get('body', '{}'))
    now = int(datetime.now().timestamp())

    item = _get_claim_item(claim_id)
    if not item:
        return response(404, {'error': 'Claim not found'})

    # State validation — can only approve claims in these states
    if item.get('status') not in ('escalated', 'resubmitted', 'submitted'):
        return response(400, {'error': 'Can only approve claims with status: escalated, resubmitted, or submitted'})

    user_info = _get_user_info(event)

    table.update_item(
        Key={'claimId': claim_id, 'timestamp': item['timestamp']},
        UpdateExpression='SET #s = :status, approvedAt = :ts, approvalNotes = :notes, updatedAt = :ts, actionBy = :actionBy',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':status': 'approved',
            ':ts': now,
            ':notes': body.get('notes', ''),
            ':actionBy': user_info['username'],
        },
    )
    return response(200, {'message': 'Claim approved', 'claimId': claim_id})


def deny_claim(event):
    """Deny a claim (adjuster only) with role check, state validation, and audit."""
    auth_err = _require_group(event, ['Adjusters'])
    if auth_err:
        return auth_err

    claim_id = event['pathParameters']['claimId']
    body = json.loads(event.get('body', '{}'))
    now = int(datetime.now().timestamp())

    item = _get_claim_item(claim_id)
    if not item:
        return response(404, {'error': 'Claim not found'})

    # State validation — can only deny claims in these states
    if item.get('status') not in ('escalated', 'resubmitted', 'submitted'):
        return response(400, {'error': 'Can only deny claims with status: escalated, resubmitted, or submitted'})

    user_info = _get_user_info(event)

    table.update_item(
        Key={'claimId': claim_id, 'timestamp': item['timestamp']},
        UpdateExpression='SET #s = :status, deniedAt = :ts, denialReason = :reason, updatedAt = :ts, actionBy = :actionBy',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':status': 'denied',
            ':ts': now,
            ':reason': body.get('reason', 'No reason provided'),
            ':actionBy': user_info['username'],
        },
    )
    return response(200, {'message': 'Claim denied', 'claimId': claim_id})


def resubmit_claim(event):
    """Resubmit a claim with additional information/documents.

    Allows claimants to follow up on escalated or denied claims by providing
    additional documents or updating fields. Resets status to 'resubmitted'
    and triggers AI re-processing via EventBridge.

    Max 5 resubmission attempts per claim.
    """
    claim_id = event['pathParameters']['claimId']
    body = json.loads(event.get('body', '{}'))
    now = int(datetime.now().timestamp())

    item = _get_claim_item(claim_id)
    if not item:
        return response(404, {'error': 'Claim not found'})

    # Only allow resubmission for escalated or denied claims
    current_status = item.get('status', '')
    if current_status not in ('escalated', 'denied'):
        return response(400, {
            'error': f"Cannot resubmit claim with status '{current_status}'. Only escalated or denied claims can be resubmitted."
        })

    # Enforce max 5 resubmission attempts
    resubmission_count = int(item.get('resubmissionCount', 0))
    if resubmission_count >= 5:
        return response(400, {
            'error': 'Maximum resubmission attempts reached (5). Please contact support for further assistance.'
        })

    # Build update expression
    update_expr = 'SET #s = :status, updatedAt = :ts, resubmissionCount = :count, resubmittedAt = :ts'
    expr_values = {
        ':status': 'resubmitted',
        ':ts': now,
        ':count': resubmission_count + 1,
    }
    expr_names = {'#s': 'status'}

    # Allow updating optional fields (e.g., causeOfDeath, relationship)
    # Validate field lengths to prevent abuse (BSC AWS-307)
    _RESUBMIT_FIELD_LIMITS = {
        'causeOfDeath': 500,
        'relationship': 256,
        'additionalNotes': 2000,
        'notes': 2000,
    }
    for field, max_len in _RESUBMIT_FIELD_LIMITS.items():
        val = body.get(field, '')
        if val and len(str(val)) > max_len:
            return response(400, {'error': f"Field '{field}' exceeds maximum length of {max_len} characters"})

    # Prompt injection detection on resubmission free-text fields
    for field in ['causeOfDeath', 'relationship', 'additionalNotes', 'notes']:
        val = body.get(field, '')
        if val:
            for pattern in _INJECTION_PATTERNS:
                if re.search(pattern, str(val), re.IGNORECASE):
                    print(f"Prompt injection blocked in resubmit field '{field}'")
                    return response(400, {'error': 'Request rejected: input contains disallowed patterns'})

    updatable_fields = ['causeOfDeath', 'relationship', 'additionalNotes']
    for field in updatable_fields:
        if field in body and body[field]:
            update_expr += f', {field} = :{field}'
            expr_values[f':{field}'] = body[field]

    # Store previous decision context for AI re-processing
    previous_decision = {
        'previousStatus': current_status,
        'previousReasoning': item.get('processingDetails', ''),
        'resubmissionNotes': body.get('notes', ''),
        'resubmissionAttempt': resubmission_count + 1,
    }
    update_expr += ', previousDecision = :prev'
    expr_values[':prev'] = json.dumps(previous_decision)

    table.update_item(
        Key={'claimId': claim_id, 'timestamp': item['timestamp']},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )

    # Emit EventBridge event to trigger re-processing
    try:
        events_client = boto3.client('events')
        event_bus = os.environ.get('EVENT_BUS_NAME', 'claims-processing-bus')
        events_client.put_events(
            Entries=[{
                'Source': 'claims.lifecycle',
                'DetailType': 'ClaimResubmitted',
                'Detail': json.dumps({
                    'claimId': claim_id,
                    'claimTimestamp': int(item['timestamp']),
                    'resubmissionAttempt': resubmission_count + 1,
                    'previousStatus': current_status,
                }),
                'EventBusName': event_bus,
            }]
        )
        print(f"EventBridge event emitted: ClaimResubmitted for {claim_id} (attempt {resubmission_count + 1})")
    except Exception as e:
        print(f"Failed to emit ClaimResubmitted event: {e}")
        # Fallback: self-invoke to trigger re-processing directly
        try:
            lambda_client = boto3.client('lambda')
            lambda_client.invoke(
                FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', ''),
                InvocationType='Event',
                Payload=json.dumps({
                    '_async_process': True,
                    'claimId': claim_id,
                    'claimTimestamp': int(item['timestamp']),
                }),
            )
            print(f"Fallback: self-invoke triggered for resubmission {claim_id}")
        except Exception as fallback_err:
            print(f"Fallback self-invoke also failed: {fallback_err}")

    return response(200, {
        'message': 'Claim resubmitted for review',
        'claimId': claim_id,
        'resubmissionAttempt': resubmission_count + 1,
        'maxAttempts': 5,
        'status': 'resubmitted',
    })


def reset_demo(event):
    """Reset demo to a fresh state.

    Clears all claims from DynamoDB and removes uploaded documents from S3.
    This gives a clean slate as if the system was freshly deployed.
    """
    auth_err = _require_group(event, ['Adjusters'])
    if auth_err:
        return auth_err

    print("RESET: Starting demo reset...")

    # 1. Clear all claims from DynamoDB
    claims_deleted = 0
    scan_result = table.scan(ProjectionExpression='claimId, #ts', ExpressionAttributeNames={'#ts': 'timestamp'})
    items = scan_result.get('Items', [])

    while True:
        with table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={'claimId': item['claimId'], 'timestamp': item['timestamp']})
                claims_deleted += 1

        if 'LastEvaluatedKey' not in scan_result:
            break
        scan_result = table.scan(
            ProjectionExpression='claimId, #ts',
            ExpressionAttributeNames={'#ts': 'timestamp'},
            ExclusiveStartKey=scan_result['LastEvaluatedKey'],
        )
        items = scan_result.get('Items', [])

    print(f"RESET: Deleted {claims_deleted} claims from DynamoDB")

    # 2. Clear uploaded documents from S3 (both key patterns)
    docs_deleted = 0
    try:
        for prefix in ['CLM-', 'claims/CLM-']:
            paginator = s3.get_paginator('list_objects_v2')
            for page in paginator.paginate(Bucket=DOCUMENTS_BUCKET, Prefix=prefix):
                objects = page.get('Contents', [])
                if objects:
                    delete_keys = [{'Key': obj['Key']} for obj in objects]
                    s3.delete_objects(
                        Bucket=DOCUMENTS_BUCKET,
                        Delete={'Objects': delete_keys},
                    )
                    docs_deleted += len(delete_keys)
    except Exception as e:
        print(f"RESET: Error clearing S3 documents: {e}")

    print(f"RESET: Deleted {docs_deleted} documents from S3")

    return response(200, {
        'message': 'Demo reset complete',
        'claimsDeleted': claims_deleted,
        'documentsDeleted': docs_deleted,
    })
# force-deploy Sat Jul  4 18:33:03 EDT 2026

"""
Chat Handler Lambda
Lightweight FAQ chatbot for claimant guidance using Bedrock Claude.
"""
import json
import os
import boto3

bedrock_runtime = boto3.client('bedrock-runtime', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')
GUARDRAIL_ID = os.environ.get('GUARDRAIL_ID', '')

ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}

SYSTEM_PROMPT = """You are a helpful claims assistant for CCOE Insurance Industry LLC, a life insurance company specializing in death benefits claims processing.

Your role is to guide claimants through the claims submission process. Be warm, empathetic, and clear — people filing death benefits claims are going through a difficult time.

KEY INFORMATION YOU KNOW:

REQUIRED DOCUMENTS:
- Death Certificate (certified copy from the state vital records office)
- Policy Document (original or copy of the life insurance policy)
- Beneficiary Identification (government-issued photo ID — driver's license, passport, etc.)
- Medical Records (hospital discharge summary, attending physician's statement)
- Claim Form (completed through our online portal)

OPTIONAL BUT HELPFUL DOCUMENTS:
- Police Report (if death involved an accident or suspicious circumstances)
- Autopsy Report (if one was performed)
- Trust Documents (if beneficiary is a trust)
- Marriage/Birth Certificate (to prove relationship if needed)
- Previous Policy Documents (if policy was recently changed)

CLAIMS PROCESS STEPS:
1. Submit your claim through the Claimant Portal with all required information
2. Upload supporting documents (death certificate, policy, ID, medical records)
3. Our AI system reviews your claim automatically — most decisions in minutes
4. Clean claims under $50,000 with all documents are typically auto-approved
5. Complex or high-value claims may be escalated to a human adjuster for review
6. You can track your claim status in real-time through the portal

COMMON QUESTIONS:
- Processing time: Most claims are processed within minutes. Complex cases may take 1-2 business days.
- Claim amount: You can claim up to the full face value of the policy. Partial claims are also accepted.
- Multiple beneficiaries: If the policy has multiple beneficiaries, each should file separately for their portion.
- Lapsed policies: If premiums were not current at time of death, the claim will likely be denied. Check policy status first.
- Contestability period: Policies less than 2 years old may be subject to additional review.
- Suicide clause: Most policies have a 2-year suicide exclusion. Claims within this period may be limited to premium refund.

RULES:
- Only answer questions related to life insurance claims, death benefits, and the claims process
- Do not provide legal, tax, or financial advice — recommend consulting a professional
- Do not discuss specific claim decisions or policy details — direct them to check their claim status in the portal
- Be concise — keep responses under 150 words
- If you don't know something, say so and suggest they contact support
- Never make up policy numbers, claim IDs, or specific dollar amounts"""


def handler(event, context):
    try:
        http_method = event.get('httpMethod', '')

        if http_method == 'OPTIONS':
            return response(200, {})

        if http_method != 'POST':
            return response(404, {'error': 'Not found'})

        body = json.loads(event.get('body', '{}'))
        message = body.get('message', '').strip()

        if not message:
            return response(400, {'error': 'Message is required'})

        # Build conversation history
        messages = []
        history = body.get('history', [])
        for h in history[-6:]:  # Keep last 6 messages for context
            role = h.get('role', 'user')
            if role not in ('user', 'assistant'):
                role = 'user'
            messages.append({
                'role': role,
                'content': h.get('content', ''),
            })
        messages.append({'role': 'user', 'content': message})

        # Apply Bedrock Guardrail to user input (blocks prompt injection attacks)
        if GUARDRAIL_ID:
            try:
                guardrail_response = bedrock_runtime.apply_guardrail(
                    guardrailIdentifier=GUARDRAIL_ID,
                    guardrailVersion='DRAFT',
                    source='INPUT',
                    content=[{'text': {'text': message}}],
                )
                if guardrail_response.get('action') == 'GUARDRAIL_INTERVENED':
                    # Check if it was a prompt attack (block) vs topic/PII filter (allow for chat)
                    assessments = guardrail_response.get('assessments', [])
                    is_prompt_attack = False
                    for assessment in assessments:
                        content_policy = assessment.get('contentPolicy', {})
                        for filter_result in content_policy.get('filters', []):
                            if filter_result.get('type') == 'PROMPT_ATTACK' and filter_result.get('action') == 'BLOCKED':
                                is_prompt_attack = True
                        word_policy = assessment.get('wordPolicy', {})
                        if word_policy.get('customWords') or word_policy.get('managedWordLists'):
                            is_prompt_attack = True
                    if is_prompt_attack:
                        return response(400, {
                            'reply': 'I cannot process that request. Please rephrase your question about claims processing.'
                        })
            except Exception as guardrail_err:
                print(f"Guardrail check failed (non-blocking): {guardrail_err}")

        resp = bedrock_runtime.invoke_model(
            modelId=MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 512,
                'system': SYSTEM_PROMPT,
                'messages': messages,
                'temperature': 0.3,
            }),
        )

        result = json.loads(resp['body'].read())
        reply = result['content'][0]['text']

        return response(200, {'reply': reply})

    except Exception as e:
        print(f"Chat error: {str(e)}")
        return response(500, {'error': 'Sorry, I encountered an issue. Please try again.'})


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body),
    }

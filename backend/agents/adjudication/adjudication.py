"""
CCOE Insurance Industry LLC - Adjudication Agent
Makes final approval/denial decisions for death benefits claims
Deployed on Amazon Bedrock AgentCore Runtime with Strands SDK
"""

import json
import os
import boto3
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

CLAIMS_TABLE = os.environ.get('CLAIMS_TABLE', '')
REGULATORY_KB_ID = os.environ.get('REGULATORY_KB_ID', '')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')
REGION = os.environ.get('AWS_REGION', 'us-east-1')


@tool
def query_regulatory_guidelines(query: str) -> str:
    """Query the regulatory knowledge base for compliance rules and requirements.

    Args:
        query: Search query about regulatory guidelines
    """
    client = boto3.client('bedrock-agent-runtime', region_name=REGION)
    response = client.retrieve(
        knowledgeBaseId=REGULATORY_KB_ID,
        retrievalQuery={'text': query},
        retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 5}}
    )
    results = [{'content': r['content']['text'], 'score': r['score']}
               for r in response.get('retrievalResults', [])]
    return json.dumps({'results': results})


@tool
def update_claim_decision(claim_id: str, decision: str, payout_amount: str, reasoning: str) -> str:
    """Update the claim with the final adjudication decision in DynamoDB.

    Args:
        claim_id: The claim identifier
        decision: approve, deny, or human_review
        payout_amount: Dollar amount if approved, 0 otherwise
        reasoning: Detailed reasoning for the decision
    """
    import time

    # Validate decision parameter
    VALID_DECISIONS = {'approve', 'deny', 'human_review'}
    if decision not in VALID_DECISIONS:
        return json.dumps({'success': False, 'error': f'Invalid decision: {decision}'})

    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(CLAIMS_TABLE)
    status_map = {'approve': 'Approved', 'deny': 'Denied', 'human_review': 'PendingReview'}
    table.update_item(
        Key={'claimId': claim_id},
        UpdateExpression='SET #s = :s, adjudicationResult = :r, updatedAt = :t',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':s': status_map.get(decision, 'PendingReview'),
            ':r': json.dumps({'decision': decision, 'payout': payout_amount, 'reasoning': reasoning}),
            ':t': int(time.time()),
        }
    )
    return json.dumps({'success': True, 'claim_id': claim_id, 'decision': decision})


SYSTEM_PROMPT = """You are the Adjudication Agent for CCOE Insurance Industry LLC's death benefits claims processing.

Your responsibilities:
1. Make final approval/denial decisions based on all gathered information
2. Calculate payout amounts for approved claims
3. Determine if human review is required
4. Ensure compliance with regulations

AUTO-APPROVE if ALL: auth confidence > 0.85, policy active, no exclusions, fraud < 0.3, amount < $50,000
AUTO-DENY if ANY: policy lapsed, excluded cause, fraud > 0.8, material misrepresentation
ESCALATE if: amount >= $50,000, fraud 0.5-0.8, missing docs, unclear exclusions

Use query_regulatory_guidelines for compliance checks.
Use update_claim_decision to record the final decision.

OUTPUT FORMAT (JSON):
{
  "decision": "approve/deny/human_review",
  "payout_amount": number,
  "reasoning": "detailed explanation",
  "next_steps": "what happens next"
}"""


@app.entrypoint
def invoke(payload, context=None):
    prompt = payload.get("prompt", "Hello")
    agent = Agent(
        tools=[query_regulatory_guidelines, update_claim_decision],
        system_prompt=SYSTEM_PROMPT, model=MODEL_ID, name="AdjudicationAgent"
    )
    result = agent(prompt)
    return {
        "status": "success",
        "agent": "AdjudicationAgent",
        "response": result.message.get('content', [{}])[0].get('text', str(result))
    }


if __name__ == "__main__":
    app.run()

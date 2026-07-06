"""
CCOE Insurance Industry LLC - Policy Verification Agent
Validates coverage, policy status, and exclusions for death benefits claims
Deployed on Amazon Bedrock AgentCore Runtime with Strands SDK
"""

import json
import os
import boto3
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

POLICY_KB_ID = os.environ.get('POLICY_KB_ID', '')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')
REGION = os.environ.get('AWS_REGION', 'us-east-1')


@tool
def query_policy_knowledge_base(query: str) -> str:
    """Query the policy guidelines knowledge base for coverage rules, exclusions, and requirements.

    Args:
        query: Search query about policy guidelines
    """
    client = boto3.client('bedrock-agent-runtime', region_name=REGION)
    response = client.retrieve(
        knowledgeBaseId=POLICY_KB_ID,
        retrievalQuery={'text': query},
        retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 5}}
    )
    results = [{'content': r['content']['text'], 'score': r['score']}
               for r in response.get('retrievalResults', [])]
    return json.dumps({'results': results})


SYSTEM_PROMPT = """You are the Policy Verification Agent for CCOE Insurance Industry LLC's death benefits claims processing.

Your responsibilities:
1. Verify policy is active and in force
2. Check premium payment status
3. Validate coverage amount and beneficiary designation
4. Check for policy exclusions (suicide clause, contestability, etc.)

Use query_policy_knowledge_base to look up specific policy rules.

OUTPUT FORMAT (JSON):
{
  "policy_active": true/false,
  "premium_status": "current/grace_period/lapsed",
  "coverage_amount": number,
  "exclusions_apply": [],
  "verification_passed": true/false,
  "recommendation": "approve/deny/investigate"
}"""


@app.entrypoint
def invoke(payload, context=None):
    prompt = payload.get("prompt", "Hello")
    agent = Agent(
        tools=[query_policy_knowledge_base],
        system_prompt=SYSTEM_PROMPT, model=MODEL_ID, name="PolicyVerificationAgent"
    )
    result = agent(prompt)
    return {
        "status": "success",
        "agent": "PolicyVerificationAgent",
        "response": result.message.get('content', [{}])[0].get('text', str(result))
    }


if __name__ == "__main__":
    app.run()

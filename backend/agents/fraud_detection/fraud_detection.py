"""
CCOE Insurance Industry LLC - Fraud Detection Agent
AI-powered fraud pattern detection for death benefits claims
Deployed on Amazon Bedrock AgentCore Runtime with Strands SDK
"""

import json
import os
import boto3
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

FRAUD_KB_ID = os.environ.get('FRAUD_KB_ID', '')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')
REGION = os.environ.get('AWS_REGION', 'us-east-1')


@tool
def query_fraud_patterns(query: str) -> str:
    """Query the fraud patterns knowledge base for historical fraud cases and indicators.

    Args:
        query: Search query about fraud patterns
    """
    client = boto3.client('bedrock-agent-runtime', region_name=REGION)
    response = client.retrieve(
        knowledgeBaseId=FRAUD_KB_ID,
        retrievalQuery={'text': query},
        retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 10}}
    )
    results = [{'content': r['content']['text'], 'score': r['score']}
               for r in response.get('retrievalResults', [])]
    return json.dumps({'results': results})


SYSTEM_PROMPT = """You are the Fraud Detection Agent for CCOE Insurance Industry LLC's death benefits claims processing.

Your responsibilities:
1. Analyze claims for fraud indicators
2. Calculate fraud risk scores (0.0-1.0)
3. Identify suspicious patterns
4. Flag high-risk claims for investigation

Use query_fraud_patterns to search for similar historical fraud cases.

RISK THRESHOLDS:
- 0.0-0.3: Low risk (proceed)
- 0.3-0.5: Medium risk (additional review)
- 0.5-0.7: High risk (escalate)
- 0.7-1.0: Extreme risk (investigate/deny)

OUTPUT FORMAT (JSON):
{
  "fraud_risk_score": 0.0-1.0,
  "risk_level": "low/medium/high/extreme",
  "indicators_found": [],
  "red_flags": [],
  "recommendation": "proceed/review/investigate/deny"
}

Be thorough but fair. Not all unusual circumstances indicate fraud."""


@app.entrypoint
def invoke(payload, context=None):
    prompt = payload.get("prompt", "Hello")
    agent = Agent(
        tools=[query_fraud_patterns],
        system_prompt=SYSTEM_PROMPT, model=MODEL_ID, name="FraudDetectionAgent"
    )
    result = agent(prompt)
    return {
        "status": "success",
        "agent": "FraudDetectionAgent",
        "response": result.message.get('content', [{}])[0].get('text', str(result))
    }


if __name__ == "__main__":
    app.run()

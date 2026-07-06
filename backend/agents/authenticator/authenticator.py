"""
CCOE Insurance Industry LLC - Authenticator Agent
Validates beneficiary identity and death benefits claim authenticity
Deployed on Amazon Bedrock AgentCore Runtime with Strands SDK
"""

import json
import os
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')

SYSTEM_PROMPT = """You are the Authenticator Agent for CCOE Insurance Industry LLC's death benefits claims processing.

Your responsibilities:
1. Validate beneficiary identity
2. Verify relationship to policy holder
3. Check claim form completeness
4. Assess signature authenticity
5. Identify any red flags in the claim submission

CONFIDENCE SCORING:
- High (0.9-1.0): All checks pass, no concerns
- Medium (0.7-0.89): Minor issues, may need clarification
- Low (0.0-0.69): Significant concerns, requires investigation

OUTPUT FORMAT (JSON):
{
  "authenticated": true/false,
  "confidence_score": 0.0-1.0,
  "checks_passed": [],
  "checks_failed": [],
  "concerns": [],
  "recommendation": "approve/request_more_info/investigate"
}

Always be thorough but fair."""


@app.entrypoint
def invoke(payload, context=None):
    prompt = payload.get("prompt", "Hello")
    agent = Agent(system_prompt=SYSTEM_PROMPT, model=MODEL_ID, name="AuthenticatorAgent")
    result = agent(prompt)
    return {
        "status": "success",
        "agent": "AuthenticatorAgent",
        "response": result.message.get('content', [{}])[0].get('text', str(result))
    }


if __name__ == "__main__":
    app.run()

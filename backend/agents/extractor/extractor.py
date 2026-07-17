"""
CCOE Insurance Industry LLC - Extractor Agent
OCR and intelligent document processing for death benefits claims
Deployed on Amazon Bedrock AgentCore Runtime with Strands SDK
"""

import json
import os
import boto3
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

DOCUMENTS_BUCKET = os.environ.get('DOCUMENTS_BUCKET', '')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-20250514-v1:0')
REGION = os.environ.get('AWS_REGION', 'us-east-1')


@tool
def extract_with_textract(bucket: str, key: str) -> str:
    """Use AWS Textract to perform OCR on a document. Returns raw text and key-value pairs.

    Args:
        bucket: S3 bucket name
        key: S3 object key
    """
    textract = boto3.client('textract', region_name=REGION)
    response = textract.analyze_document(
        Document={'S3Object': {'Bucket': bucket, 'Name': key}},
        FeatureTypes=['FORMS', 'TABLES']
    )
    text = [b['Text'] for b in response['Blocks'] if b['BlockType'] == 'LINE']
    return json.dumps({'raw_text': '\n'.join(text), 'block_count': len(response['Blocks'])})


@tool
def extract_medical_entities(text: str) -> str:
    """Use AWS Comprehend Medical to extract medical entities from text.

    Args:
        text: Medical text to analyze
    """
    comprehend = boto3.client('comprehendmedical', region_name=REGION)
    entities = comprehend.detect_entities_v2(Text=text)
    icd = comprehend.infer_icd10_cm(Text=text)
    return json.dumps({
        'entities': [{'text': e['Text'], 'category': e['Category']} for e in entities.get('Entities', [])[:20]],
        'icd_codes': [{'code': e.get('ICD10CMConcepts', [{}])[0].get('Code', ''), 'description': e['Text']}
                      for e in icd.get('Entities', [])[:10]]
    })


SYSTEM_PROMPT = """You are the Extractor Agent for CCOE Insurance Industry LLC's death benefits claims processing.

Your responsibilities:
1. Extract structured data from claim documents using OCR
2. Identify key fields from death certificates, medical records, and policy documents
3. Validate extracted data for completeness
4. Flag missing or unclear information

Use extract_with_textract for OCR and extract_medical_entities for medical documents.

OUTPUT FORMAT (JSON):
{
  "extracted_data": {"death_certificate": {}, "medical_records": {}, "policy_documents": {}},
  "completeness_score": 0.0-1.0,
  "missing_fields": [],
  "recommendation": "complete/request_additional_documents"
}"""


@app.entrypoint
def invoke(payload, context=None):
    prompt = payload.get("prompt", "Hello")
    agent = Agent(
        tools=[extract_with_textract, extract_medical_entities],
        system_prompt=SYSTEM_PROMPT, model=MODEL_ID, name="ExtractorAgent"
    )
    result = agent(prompt)
    return {
        "status": "success",
        "agent": "ExtractorAgent",
        "response": result.message.get('content', [{}])[0].get('text', str(result))
    }


if __name__ == "__main__":
    app.run()

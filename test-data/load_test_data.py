"""
Load test scenarios into DynamoDB and upload sample documents to S3.
Usage: python3 load_test_data.py
"""

import boto3
import json
import os
import sys
import time
from datetime import datetime

# Get stack outputs
cfn = boto3.client('cloudformation', region_name='us-east-1')

def get_output(stack_name, key):
    resp = cfn.describe_stacks(StackName=stack_name)
    for output in resp['Stacks'][0].get('Outputs', []):
        if output['OutputKey'] == key:
            return output['OutputValue']
    return None

# Auto-discover resource names from stack outputs
CLAIMS_TABLE = get_output('LifeInsuranceInfraStack', 'ClaimsTableName')
DOCS_BUCKET = get_output('LifeInsuranceInfraStack', 'DocumentsBucketName')

if not CLAIMS_TABLE or not DOCS_BUCKET:
    # Fallback: scan for resources
    ddb = boto3.client('dynamodb', region_name='us-east-1')
    tables = ddb.list_tables()['TableNames']
    CLAIMS_TABLE = next((t for t in tables if 'Claims' in t and 'LifeInsurance' in t), None)

    s3c = boto3.client('s3', region_name='us-east-1')
    buckets = [b['Name'] for b in s3c.list_buckets()['Buckets']]
    DOCS_BUCKET = next((b for b in buckets if 'document' in b and 'life-insurance' in b.lower()), None)

print(f"Claims Table: {CLAIMS_TABLE}")
print(f"Documents Bucket: {DOCS_BUCKET}")

if not CLAIMS_TABLE or not DOCS_BUCKET:
    print("ERROR: Could not find Claims table or Documents bucket.")
    print("Make sure the infrastructure stack is deployed.")
    sys.exit(1)

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
s3 = boto3.client('s3', region_name='us-east-1')
table = dynamodb.Table(CLAIMS_TABLE)

DOCS_DIR = os.path.join(os.path.dirname(__file__), 'documents')

# ============================================================
# Test Scenarios
# ============================================================

scenarios = [
    {
        "claimId": "CLM-DEMO-001",
        "policyNumber": "LIP-2019-087234",
        "policyHolderName": "Robert James Mitchell",
        "beneficiaryName": "Margaret Anne Mitchell",
        "relationship": "spouse",
        "dateOfDeath": "2026-02-10",
        "causeOfDeath": "Acute Myocardial Infarction due to Coronary Artery Disease. Natural causes. Certified by attending physician at Hartford Hospital.",
        "claimAmount": 25000,
        "status": "submitted",
        "scenario": "STP Auto-Approve: Clean low-value claim with all documents, active policy, natural cause of death",
        "documents": [
            {"file": "scenario1_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario1_policy_document.txt", "type": "policy_document"},
            {"file": "scenario1_beneficiary_id.txt", "type": "beneficiary_id"},
            {"file": "scenario1_medical_records.txt", "type": "medical_records"},
        ],
    },
    {
        "claimId": "CLM-DEMO-002",
        "policyNumber": "LIP-2018-054891",
        "policyHolderName": "Thomas Edward Parker",
        "beneficiaryName": "Jennifer Parker",
        "relationship": "other",
        "dateOfDeath": "2026-02-18",
        "causeOfDeath": "Cerebrovascular Accident (Stroke) due to Atrial Fibrillation. Contributing factor: Chronic Alcoholism.",
        "claimAmount": 30000,
        "status": "submitted",
        "scenario": "Auto-Deny: Policy lapsed 6 months before death, premiums unpaid since July 2025",
        "documents": [
            {"file": "scenario2_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario2_policy_document.txt", "type": "policy_document"},
            {"file": "scenario2_medical_records.txt", "type": "medical_records"},
            {"file": "scenario2_beneficiary_id.txt", "type": "beneficiary_id"},
        ],
    },
    {
        "claimId": "CLM-DEMO-003",
        "policyNumber": "LIP-2025-112847",
        "policyHolderName": "Victor Alejandro Reyes",
        "beneficiaryName": "Maria Elena Reyes",
        "relationship": "spouse",
        "dateOfDeath": "2026-02-22",
        "causeOfDeath": "Drowning - accidental fall into swimming pool. Blood alcohol level 0.18. No autopsy performed per family request.",
        "claimAmount": 45000,
        "status": "submitted",
        "scenario": "Auto-Deny (Fraud): Policy purchased 83 days before death, coverage increased 10x, beneficiary changed 45 days before death",
        "documents": [
            {"file": "scenario3_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario3_policy_document.txt", "type": "policy_document"},
            {"file": "scenario3_medical_records.txt", "type": "medical_records"},
            {"file": "scenario3_beneficiary_id.txt", "type": "beneficiary_id"},
            {"file": "scenario3_previous_policy.txt", "type": "policy_document"},
        ],
    },
    {
        "claimId": "CLM-DEMO-004",
        "policyNumber": "LIP-2015-023456",
        "policyHolderName": "Elizabeth Grace Thornton",
        "beneficiaryName": "Thornton Family Trust / Catherine Thornton-Wells",
        "relationship": "child",
        "dateOfDeath": "2026-02-08",
        "causeOfDeath": "Metastatic Pancreatic Cancer (Pancreatic Adenocarcinoma diagnosed August 2025). Contributing: Hepatic Failure. Natural causes.",
        "claimAmount": 150000,
        "status": "submitted",
        "scenario": "Manual Review: High-value claim ($150K exceeds $50K threshold). Clean claim otherwise - active policy, natural death, all docs present",
        "documents": [
            {"file": "scenario4_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario4_policy_document.txt", "type": "policy_document"},
            {"file": "scenario4_medical_records.txt", "type": "medical_records"},
            {"file": "scenario4_beneficiary_id.txt", "type": "beneficiary_id"},
            {"file": "scenario4_trust_document.txt", "type": "trust_document"},
        ],
    },
    {
        "claimId": "CLM-DEMO-005",
        "policyNumber": "LIP-2021-078345",
        "policyHolderName": "Andrew Paul Kowalski",
        "beneficiaryName": "Susan Marie Kowalski",
        "relationship": "spouse",
        "dateOfDeath": "2026-02-25",
        "causeOfDeath": "Heart Attack (per claimant report - no medical documentation provided yet)",
        "claimAmount": 35000,
        "status": "submitted",
        "scenario": "Pending Documents: Death certificate and medical records not yet provided. Only claim form and ID submitted.",
        "documents": [
            {"file": "scenario5_claim_form_only.txt", "type": "claim_form"},
            {"file": "scenario5_policy_document.txt", "type": "policy_document"},
            {"file": "scenario5_beneficiary_id.txt", "type": "beneficiary_id"},
        ],
    },
    {
        "claimId": "CLM-DEMO-006",
        "policyNumber": "LIP-2025-098712",
        "policyHolderName": "Daniel James Crawford",
        "beneficiaryName": "Karen Crawford",
        "relationship": "parent",
        "dateOfDeath": "2026-02-15",
        "causeOfDeath": "Suicide (intentional self-harm). Contributing: Major Depressive Disorder, history of substance abuse. Investigated by LA County Medical Examiner.",
        "claimAmount": 40000,
        "status": "submitted",
        "scenario": "Auto-Deny (Exclusion): Suicide within 2-year contestability period (policy age 198 days). Also material misrepresentation - undisclosed mental health history.",
        "documents": [
            {"file": "scenario6_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario6_policy_document.txt", "type": "policy_document"},
            {"file": "scenario6_medical_records.txt", "type": "medical_records"},
            {"file": "scenario6_beneficiary_id.txt", "type": "beneficiary_id"},
        ],
    },
    {
        "claimId": "CLM-DEMO-007",
        "policyNumber": "LIP-2023-065478",
        "policyHolderName": "William Henry Foster",
        "beneficiaryName": "Linda Foster / Mark Foster",
        "relationship": "spouse",
        "dateOfDeath": "2026-02-27",
        "causeOfDeath": "Complications of Pneumonia due to Chronic Obstructive Pulmonary Disease (COPD). Contributing: Congestive Heart Failure. Natural causes.",
        "claimAmount": 28000,
        "status": "submitted",
        "scenario": "Manual Review (Moderate Fraud): Undisclosed pre-existing conditions (COPD, CHF) at application, recent beneficiary change. Contestability expired so cannot rescind.",
        "documents": [
            {"file": "scenario7_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario7_policy_document.txt", "type": "policy_document"},
            {"file": "scenario7_medical_records.txt", "type": "medical_records"},
            {"file": "scenario7_beneficiary_id.txt", "type": "beneficiary_id"},
        ],
    },
    {
        "claimId": "CLM-DEMO-008",
        "policyNumber": "LIP-2020-041589",
        "policyHolderName": "James Richard O'Brien",
        "beneficiaryName": "Michael O'Brien",
        "relationship": "child",
        "dateOfDeath": "2026-03-01",
        "causeOfDeath": "Acute Myocardial Infarction due to Coronary Artery Disease. Natural causes. Certified by attending physician at Massachusetts General Hospital.",
        "claimAmount": 50000,
        "status": "submitted",
        "scenario": "Beneficiary Mismatch: Son (Michael) filing instead of designated beneficiary (Patricia, spouse). Policy is otherwise clean. Should escalate for legal standing verification.",
        "documents": [
            {"file": "scenario1_death_certificate.txt", "type": "death_certificate"},
            {"file": "scenario1_policy_document.txt", "type": "policy_document"},
            {"file": "scenario1_beneficiary_id.txt", "type": "beneficiary_id"},
        ],
    },
]

# ============================================================
# Load data
# ============================================================

def upload_document(claim_id, doc_info):
    """Upload a sample document to S3."""
    local_path = os.path.join(DOCS_DIR, doc_info['file'])
    if not os.path.exists(local_path):
        print(f"  WARNING: Document not found: {local_path}")
        return None

    s3_key = f"claims/{claim_id}/{doc_info['type']}/{doc_info['file']}"
    s3.upload_file(local_path, DOCS_BUCKET, s3_key)
    print(f"  Uploaded: {doc_info['file']} -> s3://{DOCS_BUCKET}/{s3_key}")
    return {
        "documentId": f"DOC-{claim_id}-{doc_info['type'][:4].upper()}",
        "documentType": doc_info['type'],
        "fileName": doc_info['file'],
        "uploadedAt": int(time.time()),
        "s3Key": s3_key,
    }


def load_scenario(scenario):
    """Load a single test scenario."""
    claim_id = scenario['claimId']
    print(f"\n{'='*60}")
    print(f"Loading: {claim_id} - {scenario['scenario'][:60]}...")
    print(f"{'='*60}")

    # Upload documents
    doc_records = []
    for doc in scenario.get('documents', []):
        record = upload_document(claim_id, doc)
        if record:
            doc_records.append(record)

    # Build claim record
    now = int(time.time())
    claim = {
        'claimId': claim_id,
        'policyNumber': scenario['policyNumber'],
        'policyHolderName': scenario['policyHolderName'],
        'beneficiaryName': scenario['beneficiaryName'],
        'relationship': scenario['relationship'],
        'dateOfDeath': scenario['dateOfDeath'],
        'causeOfDeath': scenario['causeOfDeath'],
        'claimAmount': int(scenario['claimAmount']),
        'status': scenario['status'],
        'scenario': scenario['scenario'],
        'submittedAt': now,
        'updatedAt': now,
        'timestamp': now,
        'documents': doc_records,
    }

    # Write to DynamoDB
    table.put_item(Item=claim)
    print(f"  Claim written to DynamoDB: {claim_id}")
    print(f"  Amount: ${scenario['claimAmount']:,.2f}")
    print(f"  Documents: {len(doc_records)} uploaded")


def main():
    print("=" * 60)
    print("CCOE Insurance - Loading Test Scenarios")
    print("=" * 60)

    for scenario in scenarios:
        load_scenario(scenario)

    print(f"\n{'='*60}")
    print(f"COMPLETE: Loaded {len(scenarios)} test scenarios")
    print(f"{'='*60}")
    print("\nScenario Summary:")
    print(f"  CLM-DEMO-001: STP Auto-Approve (clean, low-value)")
    print(f"  CLM-DEMO-002: Auto-Deny (lapsed policy)")
    print(f"  CLM-DEMO-003: Auto-Deny (high fraud indicators)")
    print(f"  CLM-DEMO-004: Manual Review (high-value $150K)")
    print(f"  CLM-DEMO-005: Pending Documents (missing death cert)")
    print(f"  CLM-DEMO-006: Auto-Deny (suicide exclusion)")
    print(f"  CLM-DEMO-007: Manual Review (moderate fraud score)")
    print(f"\nLogin as claimant1/Test123! to see claims in portal")
    print(f"Login as adjuster1/Test123! to review in workbench")
    print(f"Login as business1/Test123! to see dashboard metrics")


if __name__ == '__main__':
    main()

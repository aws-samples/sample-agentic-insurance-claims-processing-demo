#!/usr/bin/env python3
"""
Load Knowledge Base Data
Uploads knowledge base content to S3
"""

import boto3
import json
import os
import sys
from pathlib import Path

# Initialize S3 client
s3_client = boto3.client('s3')

# Get bucket name from environment or CloudFormation outputs
KB_BUCKET = os.environ.get('KB_BUCKET', None)

if not KB_BUCKET:
    # Try to read from outputs.json
    try:
        with open('../infrastructure/outputs.json', 'r', encoding='utf-8') as f:
            outputs = json.load(f)
            for stack_outputs in outputs.values():
                if 'KnowledgeBaseBucketName' in stack_outputs:
                    KB_BUCKET = stack_outputs['KnowledgeBaseBucketName']
                    break
    except:
        pass

if not KB_BUCKET:
    print("❌ Error: Could not determine Knowledge Base bucket name")
    print("Please set KB_BUCKET environment variable or ensure outputs.json exists")
    sys.exit(1)

# Knowledge base content
KNOWLEDGE_BASES = {
    'policy-guidelines': [
        ('coverage-rules.md', '''# Coverage Rules

## Death Benefit Coverage

### Standard Coverage
- Full death benefit payable for natural death
- Coverage amount as specified in policy
- No reduction for natural causes

### Accidental Death Benefit
- Double indemnity for accidental death
- Must be within rider terms
- Requires proof of accidental nature

### Exclusions
- Suicide within 2 years of policy issuance
- Death during commission of a felony
- War or military service (if excluded in policy)
- Aviation (if excluded in policy)
- Hazardous activities (if specifically excluded)

### Contestability Period
- First 2 years: Insurer may contest for material misrepresentation
- After 2 years: Policy is incontestable except for fraud
'''),
        ('exclusions.md', '''# Policy Exclusions

## Standard Exclusions

### Suicide Clause
- Death by suicide within 2 years of policy issuance
- Premiums refunded, death benefit not paid
- After 2 years, suicide is covered

### Criminal Activity
- Death during commission of a felony
- Death while fleeing from law enforcement
- Death resulting from illegal activities

### War and Military Service
- Death in war (declared or undeclared)
- Death in military service (if excluded)
- Death in acts of terrorism (varies by policy)

### Aviation
- Death as pilot or crew member (if excluded)
- Death in private aircraft (if excluded)
- Commercial aviation typically covered

### Pre-Existing Conditions
- May be excluded if not disclosed
- Applies during contestability period
- Must be material to risk assessment
'''),
    ],
    'fraud-patterns': [
        ('stoli-schemes.md', '''# Stranger-Originated Life Insurance (STOLI) Fraud

## Pattern Description
STOLI involves investors purchasing life insurance on individuals with no insurable interest.

## Red Flags
- Policy purchased by non-family member
- Premium financing arrangements
- Immediate beneficiary change after purchase
- High coverage amount relative to income
- Multiple policies purchased simultaneously

## Historical Cases
- Case 2022-456: $2M policy, beneficiary changed 30 days before death
- Case 2021-789: Premium financing scheme, 5 policies on same individual
'''),
        ('staged-accidents.md', '''# Staged Accident Fraud

## Pattern Description
Deliberate staging of accidents to appear accidental for double indemnity.

## Red Flags
- Suspicious circumstances surrounding death
- Recent accidental death benefit rider addition
- Inconsistent witness statements
- Missing or incomplete police reports
- Unusual timing of policy purchase

## Indicators
- Death scene inconsistencies
- Lack of expected injuries
- Financial distress of beneficiary
- Recent large premium payments
'''),
    ],
    'regulatory': [
        ('state-regulations.md', '''# State Insurance Regulations

## Claims Processing Requirements

### Timely Processing
- Most states require decision within 30-60 days
- Interest may accrue on delayed payments
- Penalties for unreasonable delays

### Fair Claims Handling
- Prompt investigation required
- Clear communication with beneficiaries
- Documented decision-making process
- Right to appeal denials

### Documentation Requirements
- Death certificate (certified copy)
- Proof of beneficiary identity
- Claim form completion
- Policy documents
'''),
        ('hipaa-compliance.md', '''# HIPAA Compliance for Claims Processing

## Protected Health Information (PHI)

### What is PHI
- Medical records
- Diagnosis information
- Treatment history
- Physician notes
- Test results

### Handling Requirements
- Minimum necessary standard
- Secure storage and transmission
- Access controls
- Audit trails
- Encryption at rest and in transit

### Permitted Uses
- Claims processing and adjudication
- Fraud detection and prevention
- Regulatory compliance
- Legal requirements
'''),
    ]
}

def upload_knowledge_base_content():
    """Upload knowledge base content to S3"""
    print(f"Uploading knowledge base content to: {KB_BUCKET}")
    print("")
    
    total_files = 0
    
    for kb_name, files in KNOWLEDGE_BASES.items():
        print(f"Uploading {kb_name}...")
        
        for filename, content in files:
            s3_key = f"{kb_name}/{filename}"
            
            try:
                s3_client.put_object(
                    Bucket=KB_BUCKET,
                    Key=s3_key,
                    Body=content.encode('utf-8'),
                    ContentType='text/markdown'
                )
                print(f"  ✅ {s3_key}")
                total_files += 1
            except Exception as e:
                print(f"  ❌ Error uploading {s3_key}: {str(e)}")
        
        print("")
    
    print(f"✅ Uploaded {total_files} files to knowledge bases")

def main():
    print("=" * 50)
    print("Loading Knowledge Base Data")
    print("=" * 50)
    print("")
    
    upload_knowledge_base_content()
    
    print("")
    print("=" * 50)
    print("Knowledge Base Loading Complete")
    print("=" * 50)

if __name__ == "__main__":
    main()

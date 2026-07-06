#!/usr/bin/env python3
"""
Upload demo test documents to S3 for claims processing scenarios.

Uploads the text-based demo documents from test-data/documents/ to the
Documents S3 bucket so they can be auto-attached during Quick-Fill
demo submissions.

Usage:
    python3 scripts/generate_demo_documents.py [--upload] [--list]

    --upload    Upload text documents to S3 Documents bucket
    --list      List available scenario documents

Requirements:
    pip install boto3
"""

import argparse
import sys
from pathlib import Path

DOCS_DIR = Path(__file__).parent.parent / "test-data" / "documents"

# Scenario metadata for validation
SCENARIOS = {
    '1': {'holder': 'Robert James Mitchell', 'description': 'Clean claim (auto-approve)'},
    '2': {'holder': 'Thomas Edward Parker', 'description': 'Lapsed policy (auto-deny)'},
    '3': {'holder': 'Victor Alejandro Reyes', 'description': 'Fraud indicators (auto-deny)'},
    '4': {'holder': 'Elizabeth Grace Thornton', 'description': 'High-value claim (escalate)'},
    '5': {'holder': 'Andrew Paul Kowalski', 'description': 'Missing documents (escalate)'},
    '6': {'holder': 'Daniel James Crawford', 'description': 'Suicide exclusion (auto-deny)'},
    '7': {'holder': 'William Henry Foster', 'description': 'Moderate fraud (escalate)'},
    '8': {'holder': 'Samuel Thomas Rivera', 'description': 'Grace period death (should approve)'},
    '9': {'holder': 'Marcus Anthony Walsh', 'description': 'War/terrorism exclusion (auto-deny)'},
}

REQUIRED_DOC_TYPES = ['death_certificate', 'medical_records', 'beneficiary_id']


def list_documents():
    """List all scenario documents and validate completeness."""
    print(f"\nSource directory: {DOCS_DIR}\n")

    all_files = sorted(DOCS_DIR.glob("scenario*.txt"))
    if not all_files:
        print("  No scenario documents found!")
        return

    # Group by scenario
    by_scenario = {}
    for f in all_files:
        parts = f.stem.split('_', 1)
        scenario_num = parts[0].replace('scenario', '')
        doc_type = parts[1] if len(parts) > 1 else 'unknown'
        by_scenario.setdefault(scenario_num, []).append((doc_type, f))

    for num in sorted(by_scenario.keys(), key=int):
        docs = by_scenario[num]
        meta = SCENARIOS.get(num, {'holder': 'Unknown', 'description': 'Unknown scenario'})
        doc_types = [d[0] for d in docs]

        # Check for required documents
        missing = [r for r in REQUIRED_DOC_TYPES if r not in doc_types]
        status = '\u2705' if not missing else '\u26a0\ufe0f'

        print(f"  {status} Scenario {num}: {meta['description']}")
        print(f"     Holder: {meta['holder']}")
        for doc_type, path in sorted(docs):
            size_kb = path.stat().st_size / 1024
            print(f"     - {doc_type}.txt ({size_kb:.1f} KB)")
        if missing:
            print(f"     \u26a0\ufe0f  Missing: {', '.join(missing)}")
        print()

    print(f"  Total: {len(all_files)} documents across {len(by_scenario)} scenarios")


def upload_to_s3():
    """Upload text documents to the Documents S3 bucket."""
    try:
        import boto3
    except ImportError:
        print("ERROR: boto3 not installed. Run: pip install boto3")
        sys.exit(1)

    cfn = boto3.client('cloudformation', region_name='us-east-1')

    # Get bucket name from stack outputs
    try:
        resp = cfn.describe_stacks(StackName='LifeInsuranceInfraStack')
        outputs = resp['Stacks'][0].get('Outputs', [])
        bucket_name = next(
            (o['OutputValue'] for o in outputs if o['OutputKey'] == 'DocumentsBucketName'),
            None
        )
    except Exception:
        bucket_name = None

    if not bucket_name:
        print("\n  ERROR: Could not find Documents bucket. Is the stack deployed?")
        sys.exit(1)

    s3 = boto3.client('s3', region_name='us-east-1')
    txt_files = sorted(DOCS_DIR.glob("scenario*.txt"))
    uploaded = 0

    print(f"\n  Uploading to s3://{bucket_name}/\n")

    for txt_path in txt_files:
        parts = txt_path.stem.split('_', 1)
        scenario_num = parts[0].replace('scenario', '')
        doc_type = parts[1] if len(parts) > 1 else 'document'
        claim_id = f"CLM-DEMO-00{scenario_num}"

        s3_key = f"{claim_id}/{doc_type}/{txt_path.name}"

        try:
            s3.upload_file(
                str(txt_path), bucket_name, s3_key,
                ExtraArgs={'ContentType': 'text/plain'}
            )
            uploaded += 1
            print(f"  \u2713 {s3_key}")
        except Exception as e:
            print(f"  \u2717 {s3_key}: {e}")

    print(f"\n  Uploaded {uploaded}/{len(txt_files)} documents to S3")


def main():
    parser = argparse.ArgumentParser(
        description='Manage demo test documents for claims processing scenarios (text-only)'
    )
    parser.add_argument('--upload', action='store_true', help='Upload text documents to S3')
    parser.add_argument('--list', action='store_true', help='List and validate scenario documents')
    args = parser.parse_args()

    print("=" * 50)
    print("  Claims Demo \u2014 Test Documents")
    print("=" * 50)

    if args.list or (not args.upload):
        list_documents()

    if args.upload:
        upload_to_s3()

    if not args.list and not args.upload:
        print("\n  Usage:")
        print("    python3 scripts/generate_demo_documents.py --list")
        print("    python3 scripts/generate_demo_documents.py --upload")

    print("\n" + "=" * 50)


if __name__ == '__main__':
    main()

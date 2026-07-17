#!/usr/bin/env python3
"""Clears all claims from the DynamoDB claims table and optionally removes uploaded documents from S3."""

import boto3
import sys

TABLE_NAME = 'LifeInsuranceClaims'


def clear_claims():
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(TABLE_NAME)

    print(f'Scanning {TABLE_NAME}...')
    response = table.scan(ProjectionExpression='claimId, #ts', ExpressionAttributeNames={'#ts': 'timestamp'})
    items = response.get('Items', [])

    # Handle pagination for large tables
    while 'LastEvaluatedKey' in response:
        response = table.scan(
            ProjectionExpression='claimId, #ts',
            ExpressionAttributeNames={'#ts': 'timestamp'},
            ExclusiveStartKey=response['LastEvaluatedKey'],
        )
        items.extend(response.get('Items', []))

    if not items:
        print('No claims found. Table is already empty.')
        return

    print(f'Found {len(items)} claims. Deleting...')
    for item in items:
        table.delete_item(Key={'claimId': item['claimId'], 'timestamp': item['timestamp']})
        print(f"  Deleted {item['claimId']}")

    print(f'Done. Deleted {len(items)} claims.')


def clear_documents():
    s3 = boto3.client('s3')
    buckets = s3.list_buckets()['Buckets']
    doc_bucket = next((b['Name'] for b in buckets if 'life-insurance-docs' in b['Name'].lower()), None)

    if not doc_bucket:
        print('No documents bucket found. Skipping.')
        return

    print(f'Clearing documents from {doc_bucket}...')
    paginator = s3.get_paginator('list_objects_v2')
    count = 0
    for page in paginator.paginate(Bucket=doc_bucket):
        objects = page.get('Contents', [])
        if objects:
            s3.delete_objects(Bucket=doc_bucket, Delete={'Objects': [{'Key': o['Key']} for o in objects]})
            count += len(objects)

    print(f'Deleted {count} documents from S3.')


if __name__ == '__main__':
    clear_claims()
    if '--docs' in sys.argv:
        clear_documents()
    else:
        print('Tip: Run with --docs to also clear uploaded documents from S3.')

#!/usr/bin/env python3
"""
Sync Knowledge Bases
Triggers Bedrock Knowledge Base ingestion jobs
"""

import boto3
import json
import os
import sys
import time

# Initialize Bedrock Agent client
bedrock_agent = boto3.client('bedrock-agent')

# Get KB IDs from environment or outputs
def get_kb_ids():
    kb_ids = {}
    
    # Try to read from outputs.json
    try:
        with open('../infrastructure/outputs.json', 'r', encoding='utf-8') as f:
            outputs = json.load(f)
            for stack_outputs in outputs.values():
                if 'PolicyKBId' in stack_outputs:
                    kb_ids['policy'] = stack_outputs['PolicyKBId']
                if 'FraudKBId' in stack_outputs:
                    kb_ids['fraud'] = stack_outputs['FraudKBId']
                if 'RegulatoryKBId' in stack_outputs:
                    kb_ids['regulatory'] = stack_outputs['RegulatoryKBId']
    except Exception as e:
        print(f"Warning: Could not read outputs.json: {str(e)}")
    
    return kb_ids

def start_ingestion_job(kb_id, kb_name):
    """Start ingestion job for a knowledge base"""
    print(f"Starting ingestion for {kb_name} ({kb_id})...")
    
    try:
        # Get data source ID
        response = bedrock_agent.list_data_sources(
            knowledgeBaseId=kb_id
        )
        
        if not response.get('dataSourceSummaries'):
            print(f"  ⚠️  No data sources found for {kb_name}")
            return None
        
        data_source_id = response['dataSourceSummaries'][0]['dataSourceId']
        
        # Start ingestion job
        job_response = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=kb_id,
            dataSourceId=data_source_id
        )
        
        job_id = job_response['ingestionJob']['ingestionJobId']
        print(f"  ✅ Ingestion job started: {job_id}")
        
        return job_id
    
    except Exception as e:
        print(f"  ❌ Error starting ingestion: {str(e)}")
        return None

def wait_for_ingestion(kb_id, job_id, kb_name):
    """Wait for ingestion job to complete"""
    print(f"Waiting for {kb_name} ingestion to complete...")
    
    max_wait = 600  # 10 minutes
    wait_interval = 10  # 10 seconds
    elapsed = 0
    
    while elapsed < max_wait:
        try:
            response = bedrock_agent.get_ingestion_job(
                knowledgeBaseId=kb_id,
                dataSourceId=job_id.split('/')[0],  # Extract data source ID
                ingestionJobId=job_id
            )
            
            status = response['ingestionJob']['status']
            
            if status == 'COMPLETE':
                print(f"  ✅ {kb_name} ingestion complete")
                return True
            elif status == 'FAILED':
                print(f"  ❌ {kb_name} ingestion failed")
                return False
            else:
                print(f"  ⏳ Status: {status}... ({elapsed}s elapsed)")
                time.sleep(wait_interval)
                elapsed += wait_interval
        
        except Exception as e:
            print(f"  ⚠️  Error checking status: {str(e)}")
            time.sleep(wait_interval)
            elapsed += wait_interval
    
    print(f"  ⚠️  Timeout waiting for {kb_name} ingestion")
    return False

def main():
    print("=" * 50)
    print("Syncing Knowledge Bases")
    print("=" * 50)
    print("")
    
    kb_ids = get_kb_ids()
    
    if not kb_ids:
        print("❌ Error: No knowledge base IDs found")
        print("Please ensure CDK stacks are deployed and outputs.json exists")
        sys.exit(1)
    
    print(f"Found {len(kb_ids)} knowledge bases")
    print("")
    
    # Start ingestion jobs
    jobs = {}
    for kb_name, kb_id in kb_ids.items():
        job_id = start_ingestion_job(kb_id, kb_name)
        if job_id:
            jobs[kb_name] = (kb_id, job_id)
        print("")
    
    # Note: Ingestion runs asynchronously
    # You can proceed with other deployment steps
    print("=" * 50)
    print("Ingestion Jobs Started")
    print("=" * 50)
    print("")
    print("Note: Ingestion jobs run asynchronously and may take 5-10 minutes.")
    print("You can proceed with other deployment steps.")
    print("")
    print("To check status later, use:")
    print("  aws bedrock-agent get-ingestion-job --knowledge-base-id <kb-id> --data-source-id <ds-id> --ingestion-job-id <job-id>")

if __name__ == "__main__":
    main()

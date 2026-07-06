#!/usr/bin/env python3
"""
Deploy Agents Script
Updates Lambda function code for all agents
"""

import boto3
import json
import os
import zipfile
from pathlib import Path

# Initialize AWS clients
lambda_client = boto3.client('lambda')

# Agent directories
AGENTS = [
    'supervisor',
    'authenticator',
    'extractor',
    'policy_verification',
    'fraud_detection',
    'adjudication'
]

def create_deployment_package(agent_dir):
    """Create deployment package for an agent"""
    print(f"Creating deployment package for {agent_dir}...")
    
    # Create zip file
    zip_path = f"/tmp/{agent_dir}.zip"
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add agent Python file
        agent_file = f"{agent_dir}/{agent_dir}.py"
        if os.path.exists(agent_file):
            zipf.write(agent_file, f"{agent_dir}.py")
        
        # Add requirements if exists
        req_file = f"{agent_dir}/requirements.txt"
        if os.path.exists(req_file):
            zipf.write(req_file, "requirements.txt")
    
    return zip_path

def update_lambda_function(function_name, zip_path):
    """Update Lambda function code"""
    print(f"Updating Lambda function: {function_name}...")
    
    try:
        with open(zip_path, 'rb') as f:
            zip_content = f.read()
        
        response = lambda_client.update_function_code(
            FunctionName=function_name,
            ZipFile=zip_content
        )
        
        print(f"✅ Updated {function_name}")
        return True
    
    except Exception as e:
        print(f"❌ Error updating {function_name}: {str(e)}")
        return False

def main():
    print("=" * 50)
    print("Deploying Agents to Lambda")
    print("=" * 50)
    print("")
    
    success_count = 0
    fail_count = 0
    
    for agent in AGENTS:
        # Map agent directory to Lambda function name
        function_name = f"LifeInsurance{agent.title().replace('_', '')}Agent"
        
        # Create deployment package
        zip_path = create_deployment_package(agent)
        
        # Update Lambda function
        if update_lambda_function(function_name, zip_path):
            success_count += 1
        else:
            fail_count += 1
        
        # Clean up
        if os.path.exists(zip_path):
            os.remove(zip_path)
        
        print("")
    
    print("=" * 50)
    print(f"Deployment Complete: {success_count} succeeded, {fail_count} failed")
    print("=" * 50)

if __name__ == "__main__":
    main()

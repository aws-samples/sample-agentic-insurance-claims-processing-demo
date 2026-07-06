#!/bin/bash

# Create Lambda Layer for Strands SDK 1.28.0
# This script packages Strands SDK and dependencies into a Lambda layer

set -e

echo "=========================================="
echo "Creating Lambda Layer for Strands SDK"
echo "=========================================="
echo ""

# Create temporary directory
LAYER_DIR="layers/python"
mkdir -p $LAYER_DIR

# Install Strands SDK and dependencies
echo "Installing Strands SDK 1.28.0..."
pip3 install strands-agents==1.28.0 -t $LAYER_DIR --upgrade

# Install other dependencies
echo "Installing dependencies..."
pip3 install boto3 botocore pydantic python-dateutil pyyaml -t $LAYER_DIR --upgrade

# Create zip file
echo "Creating layer zip file..."
cd layers
zip -r strands-layer.zip python/ -q
cd ..

# Clean up
echo "Cleaning up..."
rm -rf $LAYER_DIR

echo ""
echo "✅ Lambda layer created: layers/strands-layer.zip"
echo "Size: $(du -h layers/strands-layer.zip | cut -f1)"
echo ""

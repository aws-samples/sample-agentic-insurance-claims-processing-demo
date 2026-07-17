# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-07-07

### Added
- 6 AI agents on Amazon Bedrock AgentCore (Supervisor + Authenticator, Extractor, PolicyVerification, FraudDetection, Adjudication)
- ARM64 Docker containers built via CodeBuild, deployed to AgentCore Runtimes
- Event-driven claim processing via Amazon EventBridge (ClaimSubmitted, ClaimResubmitted events)
- 3 Bedrock Knowledge Bases (Policy Guidelines, Fraud Patterns, Regulations) with OpenSearch Serverless
- Bedrock Guardrail with 6 content filters, 7 PII entities, topic policies, word blocks
- AI Claims Assistant chatbot (empathetic FAQ guidance for bereaved claimants)
- Three user portals: Claimant Portal, Adjuster Workbench, Business Dashboard
- 9 pre-configured test scenarios (auto-approve, auto-deny, fraud, escalation paths)
- Demo Quick-Fill dropdown for rapid scenario demonstration
- 8-step AI Processing Flow visualization in Adjuster Workbench
- Claim resubmission workflow with previous decision context
- Cost analytics by claim complexity (simple/standard/complex)
- Configurable model selection via scripts/select_model.py and scripts/switch_model.sh
- Cognito authentication with MFA REQUIRED (TOTP), 3 role groups
- CDK infrastructure (TypeScript, 3 stacks: Infra, Agent, API)
- CloudFront with security headers (CSP, HSTS, X-Frame-Options)
- AgentCore warmup Lambda (5-minute schedule)
- Empathetic AI tone guidelines for bereaved families and military deaths
- Comprehensive documentation (Architecture, Demo Testing Guide, Deployment Guide, Roadmap)

### Security
- Server-side Cognito group authorization checks in all Lambda handlers
- Prompt injection detection (regex patterns in claims_handler.py)
- Input validation with field length limits and type checks
- CORS restricted to CloudFront domain + localhost
- DynamoDB Streams (NEW_AND_OLD_IMAGES) on Claims table for audit
- API Gateway throttling (100 burst / 50 sustained)
- git-secrets configured with AWS patterns

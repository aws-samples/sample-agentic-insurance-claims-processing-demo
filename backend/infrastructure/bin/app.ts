#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { AgentStack } from '../lib/agent-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

// Resource tagging — applied to all stacks for cost allocation and governance
cdk.Tags.of(app).add('Project', 'LifeInsuranceClaimsDemo');
cdk.Tags.of(app).add('Environment', 'Demo');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
cdk.Tags.of(app).add('CostCenter', 'Claims-AI');
cdk.Tags.of(app).add('Owner', 'CCOE-Industry-APT');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Stack 1: Core infrastructure (S3, DynamoDB, Cognito, CloudFront, OpenSearch, KBs, Guardrails)
const infraStack = new InfrastructureStack(app, 'LifeInsuranceInfraStack', {
  env,
  description: 'Core infrastructure: storage, auth, CDN, knowledge bases, guardrails',
});

// Stack 2: AgentCore runtimes (ECR-based via CodeBuild)
const agentStack = new AgentStack(app, 'LifeInsuranceAgentStack', {
  env,
  description: 'Bedrock AgentCore runtimes with ECR container deployment',
  claimsTable: infraStack.claimsTable,
  documentsBucket: infraStack.documentsBucket,
  knowledgeBases: infraStack.knowledgeBases,
  guardrailId: infraStack.guardrailId,
});

// Stack 3: API Gateway, Lambda functions, CloudWatch monitoring
const apiStack = new ApiStack(app, 'LifeInsuranceApiStack', {
  env,
  description: 'API Gateway, Lambda functions, and monitoring',
  claimsTable: infraStack.claimsTable,
  metricsTable: infraStack.metricsTable,
  documentsBucket: infraStack.documentsBucket,
  userPool: infraStack.userPool,
  supervisorRuntimeArn: agentStack.supervisorRuntimeArn,
  frontendDomain: infraStack.distribution.distributionDomainName,
  guardrailId: infraStack.guardrailId,
});

// ================================================================
// cdk-nag: AWS Solutions Checks
// ================================================================
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Suppressions for acceptable demo patterns
NagSuppressions.addStackSuppressions(infraStack, [
  { id: 'AwsSolutions-S1', reason: 'Access logs bucket does not need its own access log (circular)' },
  { id: 'AwsSolutions-S10', reason: 'S3 buckets accessed only via CloudFront OAI and IAM roles - SSL enforced at transport layer' },
  { id: 'AwsSolutions-DDB3', reason: 'Point-in-time recovery acceptable for demo tables with ephemeral data' },
  { id: 'AwsSolutions-IAM5', reason: 'Bedrock KB role needs wildcard for foundation model access' },
  { id: 'AwsSolutions-IAM4', reason: 'Lambda basic execution role is an AWS managed policy' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.11 is the latest supported runtime for this use case' },
  { id: 'AwsSolutions-COG1', reason: 'Demo user pool - password policy meets minimum requirements' },
  { id: 'AwsSolutions-COG2', reason: 'MFA (TOTP) is configured and required for all users' },
  { id: 'AwsSolutions-COG3', reason: 'Advanced security not available on Essentials pricing tier' },
  { id: 'AwsSolutions-COG8', reason: 'Plus tier not required for demo - documented as production requirement' },
  { id: 'AwsSolutions-CFR3', reason: 'CloudFront access logging not required for demo deployment' },
  { id: 'AwsSolutions-CFR4', reason: 'Custom SSL certificate not required for demo CloudFront distribution' },
  { id: 'AwsSolutions-CFR7', reason: 'OAI used for S3 origin access - OAC migration planned for production' },
  { id: 'AwsSolutions-CFR1', reason: 'Geo restrictions not required - global demo audience' },
  { id: 'AwsSolutions-CFR2', reason: 'WAF on CloudFront is production enhancement - rate limiting configured at API layer' },
]);

NagSuppressions.addStackSuppressions(agentStack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWS managed policies (LambdaBasicExecution, BedrockAgentCoreFullAccess) required for AgentCore operation' },
  { id: 'AwsSolutions-IAM5', reason: 'AgentCore roles need wildcards for runtime discovery, S3 document access, and DynamoDB index queries' },
  { id: 'AwsSolutions-CB4', reason: 'CodeBuild KMS encryption not required for demo - builds contain only open-source agent code' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.11 is the latest supported runtime for AgentCore containers' },
]);

NagSuppressions.addStackSuppressions(apiStack, [
  { id: 'AwsSolutions-IAM5', reason: 'Bedrock InvokeModel requires wildcard resource for cross-region inference' },
  { id: 'AwsSolutions-IAM4', reason: 'Lambda basic execution role is an AWS managed policy' },
  { id: 'AwsSolutions-APIG2', reason: 'Request validation handled at Lambda layer with field allowlists, length limits, and injection scanning' },
  { id: 'AwsSolutions-APIG3', reason: 'WAF on API Gateway is production enhancement - throttling and input validation configured' },
  { id: 'AwsSolutions-APIG4', reason: 'Cognito authorizer configured for all non-public endpoints' },
  { id: 'AwsSolutions-APIG1', reason: 'API Gateway access logging enabled via deploy options' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.11 is the latest supported runtime for this use case' },
  { id: 'AwsSolutions-SNS2', reason: 'SNS alarm topic does not contain sensitive data - encryption optional for demo' },
  { id: 'AwsSolutions-SNS3', reason: 'SNS alarm topic does not require SSL enforcement for demo' },
  { id: 'AwsSolutions-SQS3', reason: 'DLQ is itself the dead-letter destination - no further DLQ needed' },
  { id: 'AwsSolutions-SQS4', reason: 'DLQ does not contain sensitive data - SSL enforcement optional for demo' },
  { id: 'AwsSolutions-EB2', reason: 'EventBridge custom bus does not require KMS encryption for demo event data' },
]);

app.synth();

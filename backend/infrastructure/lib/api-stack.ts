import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  claimsTable: dynamodb.Table;
  metricsTable: dynamodb.Table;
  documentsBucket: s3.Bucket;
  userPool: cognito.UserPool;
  supervisorRuntimeArn: string;
  frontendDomain: string;
  guardrailId?: string;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Read model configuration (written by scripts/select_model.py)
    const fs = require('fs');
    const path = require('path');
    const modelConfigPath = path.join(__dirname, '..', 'model-config.json');
    let modelId = 'us.anthropic.claude-sonnet-4-20250514-v1:0'; // default fallback
    try {
      const modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8'));
      modelId = modelConfig.modelId || modelId;
    } catch {
      console.warn('model-config.json not found, using default model. Run: python3 scripts/select_model.py');
    }
    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ApiAuthorizer', {
      cognitoUserPools: [props.userPool],
    });

    // API Gateway CloudWatch Logs role (required once per account)
    const apiGwLogsRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    const apiGwAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    });

    // Allowed CORS origins — restricted to known frontend domain + localhost for dev
    const allowedOrigins = [
      `https://${props.frontendDomain}`,
      'http://localhost:5173',
      'https://localhost:5173',
    ];

    // REST API
    this.api = new apigateway.RestApi(this, 'ClaimsApi', {
      restApiName: 'LifeInsuranceClaimsAPI',
      description: 'API for life insurance claims processing',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Ensure the account-level CW role is set before the API stage is created
    this.api.deploymentStage.node.addDependency(apiGwAccount);

    // ================================================================
    // Per-function IAM roles (least privilege)
    // ================================================================
    const baseLambdaPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole');

    // Claims Handler: DynamoDB (claims) RW, S3 RW, EventBridge PutEvents
    const claimsRole = new iam.Role(this, 'ClaimsHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [baseLambdaPolicy],
    });
    props.claimsTable.grantReadWriteData(claimsRole);
    props.documentsBucket.grantReadWrite(claimsRole);

    // Process Claim Handler: DynamoDB (claims) RW, S3 RW, AgentCore Invoke, Bedrock Invoke, EventBridge PutEvents
    const processClaimRole = new iam.Role(this, 'ProcessClaimHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [baseLambdaPolicy],
    });
    props.claimsTable.grantReadWriteData(processClaimRole);
    props.documentsBucket.grantReadWrite(processClaimRole);
    processClaimRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.supervisorRuntimeArn, `${props.supervisorRuntimeArn}/*`],
    }));
    processClaimRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
      ],
    }));

    // Documents Handler: S3 RW, DynamoDB (claims) RW
    const documentsRole = new iam.Role(this, 'DocumentsHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [baseLambdaPolicy],
    });
    props.documentsBucket.grantReadWrite(documentsRole);
    props.claimsTable.grantReadWriteData(documentsRole);

    // Metrics Handler: DynamoDB (claims) Read, DynamoDB (metrics) RW
    const metricsRole = new iam.Role(this, 'MetricsHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [baseLambdaPolicy],
    });
    props.claimsTable.grantReadData(metricsRole);
    props.metricsTable.grantReadWriteData(metricsRole);

    // Chat Handler: Bedrock Invoke + ApplyGuardrail only
    const chatRole = new iam.Role(this, 'ChatHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [baseLambdaPolicy],
    });
    chatRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
      ],
    }));
    chatRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:guardrail/${props.guardrailId || '*'}`],
    }));

    // ================================================================
    // EventBridge — Claims Processing Event Bus
    // ================================================================
    const eventBus = new events.EventBus(this, 'ClaimsEventBus', {
      eventBusName: 'claims-processing-bus',
    });

    // Dead Letter Queue for failed event deliveries
    const dlq = new sqs.Queue(this, 'ClaimsEventDLQ', {
      queueName: 'claims-processing-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Grant claims and processClaimHandler permission to put events
    eventBus.grantPutEventsTo(claimsRole);
    eventBus.grantPutEventsTo(processClaimRole);

    // ================================================================
    // Lambda functions
    // ================================================================

    // Claims Processing Lambda (EventBridge target — handles AI processing)
    const processClaimHandler = new lambda.Function(this, 'ProcessClaimHandler', {
      functionName: 'LifeInsuranceProcessClaimHandler',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'process_claim_handler.handler',
      code: lambda.Code.fromAsset('../lambda/claims'),
      role: processClaimRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        CLAIMS_TABLE: props.claimsTable.tableName,
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        SUPERVISOR_RUNTIME_ARN: props.supervisorRuntimeArn,
        ALLOWED_ORIGIN: `https://${props.frontendDomain}`,
        EVENT_BUS_NAME: eventBus.eventBusName,
        MODEL_ID: modelId,
        GUARDRAIL_ID: props.guardrailId || '',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // EventBridge Rule: claims.submitted → triggers AI processing
    new events.Rule(this, 'ClaimSubmittedRule', {
      eventBus,
      ruleName: 'claims-submitted-trigger-processing',
      description: 'Triggers AI claims processing when a new claim is submitted',
      eventPattern: {
        source: ['claims.lifecycle'],
        detailType: ['ClaimSubmitted'],
      },
      targets: [new events_targets.LambdaFunction(processClaimHandler, {
        deadLetterQueue: dlq,
        retryAttempts: 2,
      })],
    });

    // EventBridge Rule: claims.resubmitted → triggers AI re-processing
    new events.Rule(this, 'ClaimResubmittedRule', {
      eventBus,
      ruleName: 'claims-resubmitted-trigger-reprocessing',
      description: 'Triggers AI re-processing when a claim is resubmitted with new information',
      eventPattern: {
        source: ['claims.lifecycle'],
        detailType: ['ClaimResubmitted'],
      },
      targets: [new events_targets.LambdaFunction(processClaimHandler, {
        deadLetterQueue: dlq,
        retryAttempts: 2,
      })],
    });

    const claimsHandler = new lambda.Function(this, 'ClaimsHandler', {
      functionName: 'LifeInsuranceClaimsHandler',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'claims_handler.handler',
      code: lambda.Code.fromAsset('../lambda/claims'),
      role: claimsRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        CLAIMS_TABLE: props.claimsTable.tableName,
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        SUPERVISOR_RUNTIME_ARN: props.supervisorRuntimeArn,
        ALLOWED_ORIGIN: `https://${props.frontendDomain}`,
        EVENT_BUS_NAME: eventBus.eventBusName,
        MODEL_ID: modelId,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const documentsHandler = new lambda.Function(this, 'DocumentsHandler', {
      functionName: 'LifeInsuranceDocumentsHandler',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'documents_handler.handler',
      code: lambda.Code.fromAsset('../lambda/documents'),
      role: documentsRole,
      timeout: cdk.Duration.seconds(60),
      environment: {
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        CLAIMS_TABLE: props.claimsTable.tableName,
        ALLOWED_ORIGIN: `https://${props.frontendDomain}`,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const metricsHandler = new lambda.Function(this, 'MetricsHandler', {
      functionName: 'LifeInsuranceMetricsHandler',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'metrics_handler.handler',
      code: lambda.Code.fromAsset('../lambda/metrics'),
      role: metricsRole,
      timeout: cdk.Duration.seconds(30),
      environment: {
        CLAIMS_TABLE: props.claimsTable.tableName,
        METRICS_TABLE: props.metricsTable.tableName,
        ALLOWED_ORIGIN: `https://${props.frontendDomain}`,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const chatHandler = new lambda.Function(this, 'ChatHandler', {
      functionName: 'LifeInsuranceChatHandler',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'chat_handler.handler',
      code: lambda.Code.fromAsset('../lambda/chat'),
      role: chatRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        MODEL_ID: modelId,
        ALLOWED_ORIGIN: `https://${props.frontendDomain}`,
        GUARDRAIL_ID: props.guardrailId || '',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // ================================================================
    // API Resources and Methods
    // ================================================================
    const authOpts = { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO };

    const claims = this.api.root.addResource('claims');
    claims.addMethod('POST', new apigateway.LambdaIntegration(claimsHandler), authOpts);
    claims.addMethod('GET', new apigateway.LambdaIntegration(claimsHandler), authOpts);

    const claim = claims.addResource('{claimId}');
    claim.addMethod('GET', new apigateway.LambdaIntegration(claimsHandler), authOpts);
    claim.addMethod('PUT', new apigateway.LambdaIntegration(claimsHandler), authOpts);

    const documents = claim.addResource('documents');
    documents.addMethod('POST', new apigateway.LambdaIntegration(documentsHandler), authOpts);
    documents.addMethod('GET', new apigateway.LambdaIntegration(documentsHandler), authOpts);

    claim.addResource('approve').addMethod('POST', new apigateway.LambdaIntegration(claimsHandler), authOpts);
    claim.addResource('deny').addMethod('POST', new apigateway.LambdaIntegration(claimsHandler), authOpts);
    claim.addResource('resubmit').addMethod('POST', new apigateway.LambdaIntegration(claimsHandler), authOpts);

    // Reset endpoint (clears all demo data)
    this.api.root.addResource('reset').addMethod('POST', new apigateway.LambdaIntegration(claimsHandler), authOpts);

    const metrics = this.api.root.addResource('metrics');
    metrics.addResource('dashboard').addMethod('GET', new apigateway.LambdaIntegration(metricsHandler), authOpts);
    metrics.addResource('breakdown').addMethod('GET', new apigateway.LambdaIntegration(metricsHandler), authOpts);

    this.api.root.addResource('chat').addMethod('POST', new apigateway.LambdaIntegration(chatHandler), authOpts);

    // CORS on error responses — restricted to known frontend domain
    const corsHeaders = {
      'Access-Control-Allow-Origin': `'https://${props.frontendDomain}'`,
      'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      'Access-Control-Allow-Methods': "'GET,POST,PUT,OPTIONS'",
    };
    this.api.addGatewayResponse('Default4XX', { type: apigateway.ResponseType.DEFAULT_4XX, responseHeaders: corsHeaders });
    this.api.addGatewayResponse('Default5XX', { type: apigateway.ResponseType.DEFAULT_5XX, responseHeaders: corsHeaders });

    // ================================================================
    // CloudWatch Monitoring (consolidated from MonitoringStack)
    // ================================================================
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Life Insurance Claims Alarms' });

    const dashboard = new cloudwatch.Dashboard(this, 'ClaimsDashboard', {
      dashboardName: 'LifeInsuranceClaimsProcessing',
    });

    const apiRequests = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway', metricName: 'Count',
      dimensionsMap: { ApiName: this.api.restApiName },
      statistic: 'Sum', period: cdk.Duration.minutes(5),
    });
    const apiLatency = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway', metricName: 'Latency',
      dimensionsMap: { ApiName: this.api.restApiName },
      statistic: 'Average', period: cdk.Duration.minutes(5),
    });
    const apiErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway', metricName: '5XXError',
      dimensionsMap: { ApiName: this.api.restApiName },
      statistic: 'Sum', period: cdk.Duration.minutes(5),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'API Requests', left: [apiRequests], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'API Latency', left: [apiLatency], width: 12 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'API Errors', left: [apiErrors], width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Capacity',
        left: [props.claimsTable.metricConsumedReadCapacityUnits()],
        right: [props.claimsTable.metricConsumedWriteCapacityUnits()],
        width: 12,
      }),
    );

    const highErrorAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
      metric: apiErrors, threshold: 10, evaluationPeriods: 2,
      alarmName: 'LifeInsuranceClaims-HighErrorRate',
    });
    highErrorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    const highLatencyAlarm = new cloudwatch.Alarm(this, 'HighLatency', {
      metric: apiLatency, threshold: 5000, evaluationPeriods: 3,
      alarmName: 'LifeInsuranceClaims-HighLatency',
    });
    highLatencyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // ================================================================
    // Outputs
    // ================================================================
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiId', { value: this.api.restApiId });
    new cdk.CfnOutput(this, 'DashboardURL', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${cdk.Aws.REGION}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}

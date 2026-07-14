import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class InfrastructureStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly frontendBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly claimsTable: dynamodb.Table;
  public readonly metricsTable: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly knowledgeBases: { [key: string]: bedrock.CfnKnowledgeBase };
  public readonly kbBucket: s3.Bucket;
  public readonly guardrailId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ================================================================
    // S3 Buckets
    // ================================================================
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `life-insurance-docs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [{
        transitions: [{
          storageClass: s3.StorageClass.INTELLIGENT_TIERING,
          transitionAfter: cdk.Duration.days(30),
        }],
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `life-insurance-frontend-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.kbBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
      bucketName: `life-insurance-kb-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ================================================================
    // CloudFront Security Headers Policy (BSC AWS-26)
    // ================================================================
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      responseHeadersPolicyName: `LifeInsurance-SecurityHeaders-${cdk.Aws.REGION}`,
      comment: 'Security headers for Life Insurance Claims Processing frontend',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(63072000),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
    });

    // ================================================================
    // CloudFront
    // ================================================================
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: 'OAI for Life Insurance Claims Frontend',
    });
    this.frontendBucket.grantRead(oai);

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.frontendBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ================================================================
    // DynamoDB
    // ================================================================
    this.claimsTable = new dynamodb.Table(this, 'ClaimsTable', {
      tableName: 'LifeInsuranceClaims',
      partitionKey: { name: 'claimId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.claimsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'submittedAt', type: dynamodb.AttributeType.NUMBER },
    });

    this.metricsTable = new dynamodb.Table(this, 'MetricsTable', {
      tableName: 'LifeInsuranceMetrics',
      partitionKey: { name: 'metricType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ================================================================
    // Cognito
    // ================================================================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'LifeInsuranceClaimsUserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      customAttributes: { role: new cognito.StringAttribute({ mutable: true }) },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'LifeInsuranceClaimsWebClient',
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
      },
    });

    new cognito.CfnUserPoolGroup(this, 'ClaimantsGroup', {
      userPoolId: this.userPool.userPoolId, groupName: 'Claimants',
      description: 'Beneficiaries who submit claims',
    });
    new cognito.CfnUserPoolGroup(this, 'AdjustersGroup', {
      userPoolId: this.userPool.userPoolId, groupName: 'Adjusters',
      description: 'Claims adjusters who review and approve claims',
    });
    new cognito.CfnUserPoolGroup(this, 'BusinessUsersGroup', {
      userPoolId: this.userPool.userPoolId, groupName: 'BusinessUsers',
      description: 'Business users who view analytics',
    });

    // ================================================================
    // Bedrock Guardrail
    // ================================================================
    const guardrail = new bedrock.CfnGuardrail(this, 'ClaimsGuardrail', {
      name: 'CCOEDeathBenefitsGuardrail',
      description: 'Guardrails for CCOE Insurance death benefits claims processing agents',
      blockedInputMessaging: 'I cannot process this request as it contains inappropriate content.',
      blockedOutputsMessaging: 'I cannot provide this response as it may contain inappropriate content.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [{
          name: 'UnrelatedTopics',
          definition: 'Topics unrelated to life insurance claims processing',
          examples: ['What do you think about politics?', 'Give me relationship advice'],
          type: 'DENY',
        }],
      },
      wordPolicyConfig: {
        wordsConfig: [{ text: 'IGNORE PREVIOUS INSTRUCTIONS' }, { text: 'DISREGARD ALL RULES' }],
        managedWordListsConfig: [{ type: 'PROFANITY' }],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'NAME', action: 'ANONYMIZE' },
          { type: 'ADDRESS', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'US_BANK_ACCOUNT_NUMBER', action: 'BLOCK' },
        ],
      },
    });
    this.guardrailId = guardrail.attrGuardrailId;

    // ================================================================
    // OpenSearch Serverless + Knowledge Bases
    // ================================================================
    const collectionName = 'life-insurance-kb';

    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: `${collectionName}-encryption`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [{ ResourceType: 'collection', Resource: [`collection/${collectionName}`] }],
        AWSOwnedKey: true,
      }),
    });

    // OpenSearch network policy — configurable access (default: restricted/VPC-only for production)
    // Use --context opensearch_public_access=true for demo/dev environments
    const opensearchPublicAccess = this.node.tryGetContext('opensearch_public_access') === 'true';

    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${collectionName}-network`,
      type: 'network',
      policy: JSON.stringify([{
        Rules: [
          { ResourceType: 'collection', Resource: [`collection/${collectionName}`] },
          { ResourceType: 'dashboard', Resource: [`collection/${collectionName}`] },
        ],
        AllowFromPublic: opensearchPublicAccess,
      }]),
    });

    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('lambda.amazonaws.com'),
      ),
      description: 'Role for Bedrock Knowledge Base to access S3 and OpenSearch',
    });

    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: `${collectionName}-access`,
      type: 'data',
      policy: cdk.Fn.sub(JSON.stringify([{
        Rules: [
          { ResourceType: 'collection', Resource: [`collection/${collectionName}`], Permission: ['aoss:*'] },
          { ResourceType: 'index', Resource: [`index/${collectionName}/*`], Permission: ['aoss:*'] },
        ],
        Principal: [
          'arn:aws:iam::${AWS::AccountId}:root',
          '${KBRoleArn}',
        ],
      }]), { KBRoleArn: kbRole.roleArn }),
    });

    const collection = new opensearchserverless.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'VECTORSEARCH',
      description: 'Vector database for life insurance claims knowledge bases',
    });
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);
    collection.addDependency(dataAccessPolicy);

    // Wait for OpenSearch access policy propagation
    const waitFn = new lambda.Function(this, 'PolicyWaitFn', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import time
def handler(event, context):
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': 'policy-wait'}
    wait = int(event['ResourceProperties'].get('WaitSeconds', 180))
    print(f'Waiting {wait}s for OpenSearch access policy propagation...')
    time.sleep(wait)
    return {'PhysicalResourceId': 'policy-wait'}
`),
      timeout: cdk.Duration.minutes(10),
      memorySize: 128,
    });

    const waitProvider = new cr.Provider(this, 'WaitProvider', { onEventHandler: waitFn });
    const policyWait = new cdk.CustomResource(this, 'PolicyPropagationDelay', {
      serviceToken: waitProvider.serviceToken,
      properties: { WaitSeconds: 180 },
    });
    policyWait.node.addDependency(collection);

    this.kbBucket.grantRead(kbRole);
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aoss:APIAccessAll'],
      resources: [collection.attrArn],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`,
      ],
    }));

    const createKB = (logicalId: string, name: string, desc: string, indexName: string, prefix: string) => {
      const kb = new bedrock.CfnKnowledgeBase(this, logicalId, {
        name, description: desc, roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: 'VECTOR',
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
          },
        },
        storageConfiguration: {
          type: 'OPENSEARCH_SERVERLESS',
          opensearchServerlessConfiguration: {
            collectionArn: collection.attrArn,
            vectorIndexName: indexName,
            fieldMapping: { vectorField: 'vector', textField: 'text', metadataField: 'metadata' },
          },
        },
      });
      kb.node.addDependency(policyWait);
      new bedrock.CfnDataSource(this, `${logicalId}DataSource`, {
        name: `${name}Source`,
        knowledgeBaseId: kb.attrKnowledgeBaseId,
        dataSourceConfiguration: {
          type: 'S3',
          s3Configuration: { bucketArn: this.kbBucket.bucketArn, inclusionPrefixes: [prefix] },
        },
      });
      return kb;
    };

    const policyKB = createKB('PolicyKB', 'LifeInsurancePolicyGuidelines', 'Policy guidelines and exclusions', 'policy-guidelines-index', 'policy-guidelines/');
    const fraudKB = createKB('FraudKB', 'LifeInsuranceFraudPatterns', 'Fraud detection patterns', 'fraud-patterns-index', 'fraud-patterns/');
    const regulatoryKB = createKB('RegulatoryKB', 'LifeInsuranceRegulations', 'Regulatory requirements', 'regulatory-index', 'regulatory/');

    this.knowledgeBases = { policy: policyKB, fraud: fraudKB, regulatory: regulatoryKB };

    // ================================================================
    // Outputs
    // ================================================================
    new cdk.CfnOutput(this, 'DocumentsBucketName', { value: this.documentsBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendURL', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'ClaimsTableName', { value: this.claimsTable.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', { value: this.kbBucket.bucketName });
    new cdk.CfnOutput(this, 'PolicyKBId', { value: policyKB.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'FraudKBId', { value: fraudKB.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'RegulatoryKBId', { value: regulatoryKB.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'OpenSearchEndpoint', { value: collection.attrCollectionEndpoint });
    new cdk.CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
  }
}

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface AgentStackProps extends cdk.StackProps {
  claimsTable: dynamodb.Table;
  documentsBucket: s3.Bucket;
  knowledgeBases: { [key: string]: bedrock.CfnKnowledgeBase };
  guardrailId: string;
}

interface AgentConfig {
  name: string;
  sourceDir: string;
  entrypoint: string;
  envVars: { [key: string]: string };
}

export class AgentStack extends cdk.Stack {
  public readonly supervisorRuntimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ================================================================
    // Agent definitions
    // ================================================================
    const agents: AgentConfig[] = [
      {
        name: 'Authenticator', sourceDir: 'authenticator', entrypoint: 'authenticator',
        envVars: {
          MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          CLAIMS_TABLE: props.claimsTable.tableName,
          GUARDRAIL_ID: props.guardrailId,
        },
      },
      {
        name: 'Extractor', sourceDir: 'extractor', entrypoint: 'extractor',
        envVars: {
          MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
          GUARDRAIL_ID: props.guardrailId,
        },
      },
      {
        name: 'PolicyVerification', sourceDir: 'policy_verification', entrypoint: 'policy_verification',
        envVars: {
          MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          POLICY_KB_ID: props.knowledgeBases.policy.attrKnowledgeBaseId,
          GUARDRAIL_ID: props.guardrailId,
        },
      },
      {
        name: 'FraudDetection', sourceDir: 'fraud_detection', entrypoint: 'fraud_detection',
        envVars: {
          MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          FRAUD_KB_ID: props.knowledgeBases.fraud.attrKnowledgeBaseId,
          GUARDRAIL_ID: props.guardrailId,
        },
      },
      {
        name: 'Adjudication', sourceDir: 'adjudication', entrypoint: 'adjudication',
        envVars: {
          MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          CLAIMS_TABLE: props.claimsTable.tableName,
          REGULATORY_KB_ID: props.knowledgeBases.regulatory.attrKnowledgeBaseId,
          GUARDRAIL_ID: props.guardrailId,
        },
      },
    ];

    // ================================================================
    // IAM Role for specialist agents
    // ================================================================
    const specialistRole = new iam.Role(this, 'SpecialistRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*` },
        },
      }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreFullAccess')],
    });

    // Bedrock model invocation — scoped to Anthropic models (foundation + inference profiles)
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
      ],
    }));
    // Knowledge Base retrieval — scoped to specific KBs
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.policy.attrKnowledgeBaseId}`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.fraud.attrKnowledgeBaseId}`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.regulatory.attrKnowledgeBaseId}`,
      ],
    }));
    // Guardrail — scoped to specific guardrail
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:guardrail/${props.guardrailId}`],
    }));
    props.claimsTable.grantReadWriteData(specialistRole);
    props.documentsBucket.grantReadWrite(specialistRole);
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['textract:AnalyzeDocument', 'textract:DetectDocumentText', 'comprehendmedical:DetectEntitiesV2', 'comprehendmedical:InferICD10CM'],
      resources: ['*'],
    }));
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    specialistRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: [
        `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));

    // ================================================================
    // IAM Role for Supervisor (same + InvokeAgentRuntime)
    // ================================================================
    const supervisorRole = new iam.Role(this, 'SupervisorRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*` },
        },
      }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreFullAccess')],
    });

    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
      ],
    }));
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.policy.attrKnowledgeBaseId}`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.fraud.attrKnowledgeBaseId}`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.knowledgeBases.regulatory.attrKnowledgeBaseId}`,
      ],
    }));
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:guardrail/${props.guardrailId}`],
    }));
    props.claimsTable.grantReadWriteData(supervisorRole);
    props.documentsBucket.grantReadWrite(supervisorRole);
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: [
        `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    supervisorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`],
    }));

    // ================================================================
    // ECR Repositories (one per agent)
    // ================================================================
    const allAgentConfigs = [...agents, {
      name: 'Supervisor', sourceDir: 'supervisor', entrypoint: 'supervisor',
      envVars: {} as { [key: string]: string }, // filled later for runtime
    }];

    const ecrRepos: { [name: string]: ecr.Repository } = {};
    for (const agent of allAgentConfigs) {
      ecrRepos[agent.name] = new ecr.Repository(this, `${agent.name}Repo`, {
        repositoryName: `life-insurance/${agent.sourceDir}`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [{ maxImageCount: 5 }],
      });
    }

    // ================================================================
    // Upload all agent source as a single S3 asset (agents/ directory)
    // ================================================================
    const agentSourceAsset = new s3assets.Asset(this, 'AgentSourceAsset', {
      path: '../agents',
      exclude: [
        '**/__pycache__/**', '**/*.pyc', '**/.DS_Store',
        '*_package/**', 'layers/**', 'config.yaml',
        'configure_orchestration.py', 'create_layer.sh', 'deploy_agents.py',
      ],
    });

    // ================================================================
    // CodeBuild project to build all 6 agent Docker images
    // ================================================================
    const buildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // Grant CodeBuild push access to all ECR repos
    for (const repo of Object.values(ecrRepos)) {
      repo.grantPullPush(buildRole);
    }
    agentSourceAsset.grantRead(buildRole);

    // ECR auth
    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // Build all agent images in a single CodeBuild project
    const agentDirs = allAgentConfigs.map(a => a.sourceDir);
    const buildCommands = agentDirs.map(dir => {
      const repoUri = ecrRepos[allAgentConfigs.find(a => a.sourceDir === dir)!.name].repositoryUri;
      return [
        `echo "Building ${dir}..."`,
        `cd /tmp/agents/${dir}`,
        `docker build -t ${repoUri}:latest .`,
        `docker push ${repoUri}:latest`,
        `cd /tmp/agents`,
      ].join(' && ');
    });

    const buildProject = new codebuild.Project(this, 'AgentImageBuilder', {
      projectName: 'LifeInsurance-AgentImageBuilder',
      role: buildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true, // Required for Docker builds
        computeType: codebuild.ComputeType.LARGE,
      },
      environmentVariables: {
        AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
        AWS_DEFAULT_REGION: { value: cdk.Aws.REGION },
        SOURCE_BUCKET: { value: agentSourceAsset.s3BucketName },
        SOURCE_KEY: { value: agentSourceAsset.s3ObjectKey },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              'echo Downloading agent source...',
              'aws s3 cp s3://$SOURCE_BUCKET/$SOURCE_KEY /tmp/agents.zip',
              'mkdir -p /tmp/agents',
              'cd /tmp/agents && unzip -o /tmp/agents.zip',
            ],
          },
          build: {
            commands: buildCommands,
          },
        },
      }),
      timeout: cdk.Duration.minutes(30),
    });

    // ================================================================
    // Custom Resource: Trigger CodeBuild and wait for completion
    // ================================================================
    const triggerFn = new lambda.Function(this, 'BuildTriggerFn', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 128,
      code: lambda.Code.fromInline(`
import boto3
import time
import json

def handler(event, context):
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': event.get('PhysicalResourceId', 'build-trigger')}

    project_name = event['ResourceProperties']['ProjectName']
    cb = boto3.client('codebuild')

    print(f'Starting CodeBuild project: {project_name}')
    resp = cb.start_build(projectName=project_name)
    build_id = resp['build']['id']
    print(f'Build started: {build_id}')

    # Poll for completion
    while True:
        time.sleep(15)
        builds = cb.batch_get_builds(ids=[build_id])
        status = builds['builds'][0]['buildStatus']
        phase = builds['builds'][0].get('currentPhase', 'UNKNOWN')
        print(f'Build status: {status}, phase: {phase}')

        if status == 'SUCCEEDED':
            print('Build succeeded')
            return {'PhysicalResourceId': build_id}
        elif status in ('FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'):
            raise Exception(f'CodeBuild failed with status: {status}')
`),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    triggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [buildProject.projectArn],
    }));

    const triggerProvider = new cr.Provider(this, 'BuildTriggerProvider', {
      onEventHandler: triggerFn,
    });

    // Hash the source asset to trigger rebuilds when agent code changes
    const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: triggerProvider.serviceToken,
      properties: {
        ProjectName: buildProject.projectName,
        SourceHash: agentSourceAsset.assetHash, // Triggers rebuild on code change
      },
    });

    // Build must complete before creating AgentCore runtimes
    buildTrigger.node.addDependency(buildProject);

    // ================================================================
    // Create AgentCore Runtimes (ECR-based, after images are built)
    // ================================================================
    const createAgentRuntime = (
      agent: AgentConfig,
      role: iam.Role,
      repo: ecr.Repository,
    ): cdk.CfnResource => {
      // Force runtime update on each deploy by including build timestamp in description
      const deployTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const runtime = new cdk.CfnResource(this, `${agent.name}Runtime`, {
        type: 'AWS::BedrockAgentCore::Runtime',
        properties: {
          AgentRuntimeName: `LifeInsurance_${agent.name}Agent`,
          AgentRuntimeArtifact: {
            ContainerConfiguration: {
              ContainerUri: `${repo.repositoryUri}:latest`,
            },
          },
          RoleArn: role.roleArn,
          NetworkConfiguration: { NetworkMode: 'PUBLIC' },
          Description: `${agent.name} agent for CCOE Insurance death benefits claims (ECR) [deploy: ${deployTimestamp}]`,
          EnvironmentVariables: agent.envVars,
        },
      });

      // Runtime depends on images being built
      runtime.node.addDependency(buildTrigger);

      new cdk.CfnOutput(this, `${agent.name}RuntimeArn`, {
        value: runtime.getAtt('AgentRuntimeArn').toString(),
      });

      return runtime;
    };

    // Deploy specialist agents
    const specialistRuntimes: { [key: string]: cdk.CfnResource } = {};
    for (const agent of agents) {
      specialistRuntimes[agent.name] = createAgentRuntime(agent, specialistRole, ecrRepos[agent.name]);
    }

    // Deploy Supervisor agent
    const supervisorConfig: AgentConfig = {
      name: 'Supervisor',
      sourceDir: 'supervisor',
      entrypoint: 'supervisor',
      envVars: {
        MODEL_ID: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        CLAIMS_TABLE: props.claimsTable.tableName,
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        GUARDRAIL_ID: props.guardrailId,
        AUTHENTICATOR_ARN: specialistRuntimes['Authenticator'].getAtt('AgentRuntimeArn').toString(),
        EXTRACTOR_ARN: specialistRuntimes['Extractor'].getAtt('AgentRuntimeArn').toString(),
        POLICYVERIFICATION_ARN: specialistRuntimes['PolicyVerification'].getAtt('AgentRuntimeArn').toString(),
        FRAUDDETECTION_ARN: specialistRuntimes['FraudDetection'].getAtt('AgentRuntimeArn').toString(),
        ADJUDICATION_ARN: specialistRuntimes['Adjudication'].getAtt('AgentRuntimeArn').toString(),
      },
    };
    const supervisorRuntime = createAgentRuntime(supervisorConfig, supervisorRole, ecrRepos['Supervisor']);

    for (const name of Object.keys(specialistRuntimes)) {
      supervisorRuntime.addDependency(specialistRuntimes[name]);
    }

    this.supervisorRuntimeArn = supervisorRuntime.getAtt('AgentRuntimeArn').toString();

    // ================================================================
    // Warm-up Lambda: Pings all 6 AgentCore runtimes every 5 minutes
    // to avoid cascading cold starts during claim processing.
    // ================================================================
    const warmupRole = new iam.Role(this, 'WarmupLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    warmupRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`],
    }));

    const warmupFn = new lambda.Function(this, 'WarmupFunction', {
      functionName: 'LifeInsurance-AgentWarmup',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 128,
      role: warmupRole,
      code: lambda.Code.fromInline(`
import boto3
import json
import os
import concurrent.futures

def handler(event, context):
    region = os.environ.get('AWS_REGION', 'us-east-1')
    arns = json.loads(os.environ.get('RUNTIME_ARNS', '[]'))
    client = boto3.client('bedrock-agentcore', region_name=region)
    results = {}

    def ping(arn):
        name = arn.split('/')[-1] if '/' in arn else arn
        try:
            resp = client.invoke_agent_runtime(
                agentRuntimeArn=arn,
                qualifier='DEFAULT',
                payload=json.dumps({'prompt': 'health check', 'warmup': True})
            )
            # Read and discard response to complete the request
            content_type = resp.get('contentType', '')
            if 'text/event-stream' in content_type:
                for line in resp['response'].iter_lines(chunk_size=1024):
                    pass
            else:
                resp['response'].read()
            return (name, 'warm')
        except Exception as e:
            return (name, f'error: {str(e)[:100]}')

    # Invoke all runtimes in parallel to warm them concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(ping, arn): arn for arn in arns}
        for future in concurrent.futures.as_completed(futures):
            name, status = future.result()
            results[name] = status
            print(f'{name}: {status}')

    print(f'Warmup complete: {json.dumps(results)}')
    return results
`),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Pass all 6 runtime ARNs as environment variable
    const allRuntimeArns: string[] = [];
    for (const name of Object.keys(specialistRuntimes)) {
      allRuntimeArns.push(specialistRuntimes[name].getAtt('AgentRuntimeArn').toString());
    }
    allRuntimeArns.push(supervisorRuntime.getAtt('AgentRuntimeArn').toString());

    // CDK doesn't allow Fn::Join in environment variables easily, so we use a
    // CfnFunction override to set the RUNTIME_ARNS env var with intrinsic functions
    const cfnWarmupFn = warmupFn.node.defaultChild as lambda.CfnFunction;
    cfnWarmupFn.addPropertyOverride('Environment.Variables.RUNTIME_ARNS',
      cdk.Fn.join('', [
        '["',
        cdk.Fn.join('","', allRuntimeArns),
        '"]',
      ])
    );

    // Schedule: every 5 minutes
    const rule = new events.Rule(this, 'WarmupSchedule', {
      ruleName: 'LifeInsurance-AgentWarmup',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    rule.addTarget(new events_targets.LambdaFunction(warmupFn));
  }
}

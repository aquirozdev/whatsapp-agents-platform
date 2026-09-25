import { Duration, RemovalPolicy, Stack, type StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";

interface PlatformStackProps extends StackProps { stage: string }

export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const table = new Table(this, "PlatformTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.STRING },
    });

    const dlq = new Queue(this, "AgentEventsDlq", {
      fifo: true,
      queueName: `whatsapp-agents-${props.stage}-dlq.fifo`,
      retentionPeriod: Duration.days(14),
    });
    const queue = new Queue(this, "AgentEvents", {
      fifo: true,
      queueName: `whatsapp-agents-${props.stage}.fifo`,
      visibilityTimeout: Duration.minutes(10),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const metaAppSecret = new Secret(this, "MetaAppSecret", {
      description: "Replace with the Meta App Secret used to validate WhatsApp webhook signatures.",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const verifyToken = new Secret(this, "WhatsAppVerifyToken", {
      description: "WhatsApp webhook verify token. Read this value and configure it in Meta Developer Console.",
      generateSecretString: { passwordLength: 36, excludePunctuation: true },
    });
    const otpHmacSecret = new Secret(this, "OtpHmacSecret", {
      description: "HMAC key used to hash OTP verification codes at rest.",
      generateSecretString: { passwordLength: 64, excludePunctuation: false },
    });

    const commonEnvironment = {
      TABLE_NAME: table.tableName,
      META_APP_SECRET_ARN: metaAppSecret.secretArn,
      WHATSAPP_VERIFY_TOKEN_SECRET_ARN: verifyToken.secretArn,
      OTP_HMAC_SECRET_ARN: otpHmacSecret.secretArn,
      DEFAULT_MODEL_ID: String(this.node.tryGetContext("defaultModelId") ?? ""),
      OTP_EMAIL_FROM: String(this.node.tryGetContext("otpEmailFrom") ?? ""),
    };

    const ingress = new NodejsFunction(this, "IngressFunction", {
      runtime: Runtime.NODEJS_22_X,
      entry: "src/functions/ingress.ts",
      handler: "handler",
      memorySize: 512,
      timeout: Duration.seconds(10),
      logRetention: RetentionDays.ONE_MONTH,
      environment: { ...commonEnvironment, QUEUE_URL: queue.queueUrl },
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });
    table.grantReadData(ingress);
    queue.grantSendMessages(ingress);
    metaAppSecret.grantRead(ingress);
    verifyToken.grantRead(ingress);

    const worker = new NodejsFunction(this, "WorkerFunction", {
      runtime: Runtime.NODEJS_22_X,
      entry: "src/functions/worker.ts",
      handler: "handler",
      memorySize: 1024,
      timeout: Duration.seconds(90),
      logRetention: RetentionDays.ONE_MONTH,
      environment: commonEnvironment,
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });

    table.grantReadWriteData(worker);
    metaAppSecret.grantRead(worker);
    verifyToken.grantRead(worker);
    otpHmacSecret.grantRead(worker);
    worker.addToRolePolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: ["*"] }));
    worker.addToRolePolicy(new PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: ["*"] }));
    worker.addToRolePolicy(new PolicyStatement({ actions: ["sns:Publish"], resources: ["*"] }));
    worker.addToRolePolicy(new PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }));

    // A single record per invocation keeps FIFO failure semantics simple and preserves
    // per-conversation ordering while Lambda still scales concurrently across message groups.
    worker.addEventSource(new SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: 20,
    }));

    new Alarm(this, "QueueAgeAlarm", {
      metric: queue.metricApproximateAgeOfOldestMessage(),
      threshold: Number(this.node.tryGetContext("queueAgeAlarmSeconds") ?? 120),
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, "DlqMessagesAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const api = new HttpApi(this, "HttpApi", {
      apiName: `whatsapp-agents-${props.stage}`,
      createDefaultStage: false,
    });

    const ingressIntegration = new HttpLambdaIntegration("IngressIntegration", ingress);
    api.addRoutes({ path: "/health", methods: [HttpMethod.GET], integration: ingressIntegration });
    api.addRoutes({ path: "/webhooks/whatsapp", methods: [HttpMethod.GET, HttpMethod.POST], integration: ingressIntegration });

    const workerIntegration = new HttpLambdaIntegration("WorkerIntegration", worker);
    api.addRoutes({ path: "/v1/chat", methods: [HttpMethod.POST], integration: workerIntegration });
    api.addRoutes({ path: "/v1/conversations/{channel}/{conversationId}/mode", methods: [HttpMethod.POST], integration: workerIntegration });

    const apiAccessLogs = new LogGroup(this, "ApiAccessLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      detailedMetricsEnabled: true,
      throttle: {
        rateLimit: Number(this.node.tryGetContext("apiRateLimit") ?? 100),
        burstLimit: Number(this.node.tryGetContext("apiBurstLimit") ?? 200),
      },
      accessLogSettings: {
        destination: new LogGroupLogDestination(apiAccessLogs),
      },
    });

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "MetaAppSecretArn", { value: metaAppSecret.secretArn });
    new CfnOutput(this, "WhatsAppVerifyTokenSecretArn", { value: verifyToken.secretArn });
    new CfnOutput(this, "OtpHmacSecretArn", { value: otpHmacSecret.secretArn });
  }
}

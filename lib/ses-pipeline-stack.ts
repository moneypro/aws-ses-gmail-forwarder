import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as path from "path";

interface DomainConfig {
  domainName: string;
  hostedZoneId: string;
  aliases?: Record<string, string>;
}

export class SesPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const destinationEmail = this.node.tryGetContext("destinationEmail");
    const domains: DomainConfig[] = this.node.tryGetContext("domains");

    if (!destinationEmail || !domains || domains.length === 0) {
        throw new Error("Missing required context: destinationEmail and domains list");
    }

    // Build routing map from alias configs
    const routingMap: Record<string, string> = {};
    for (const config of domains) {
      if (config.aliases) {
        for (const [localPart, dest] of Object.entries(config.aliases)) {
          routingMap[`${localPart}@${config.domainName}`] = dest;
        }
      }
    }

    // 1. SQS QUEUES FOR EMAIL EXTRACTION
    const extractionDLQ = new sqs.Queue(this, "EmailExtractionDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const extractionQueue = new sqs.Queue(this, "EmailExtractionQueue", {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: extractionDLQ,
        maxReceiveCount: 3,
      },
    });

    // 2. DYNAMODB ROUTING TABLE
    const routingTable = new dynamodb.Table(this, "EmailRoutingTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 3. SHARED RESOURCES
    const bucket = new s3.Bucket(this, "InboundMailBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(365 * 5) }], // 5-year retention for compliance
    });

    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "aws:Referer": this.account },
        },
      })
    );

    const ruleSet = new ses.ReceiptRuleSet(this, "CombinedRuleSet", {
      dropSpam: true,
    });

    const forwarderFunction = new lambda.Function(this, "EmailForwarder", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      environment: {
        S3_BUCKET: bucket.bucketName,
        DESTINATION_EMAIL: destinationEmail,
        ROUTING_MAP: JSON.stringify(routingMap),
        SQS_QUEUE_URL: extractionQueue.queueUrl,
        ROUTING_TABLE_NAME: routingTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    bucket.grantRead(forwarderFunction);
    routingTable.grantReadData(forwarderFunction);
    extractionQueue.grantSendMessages(forwarderFunction);
    forwarderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    // 4. ALIAS PROVISIONING API
    const iamPath = "/ses-provisioner/";

    const provisionerFunction = new lambda.Function(this, "AliasProvisioner", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/provisioner")),
      environment: {
        ROUTING_TABLE_NAME: routingTable.tableName,
        AWS_SES_REGION: this.region,
        IAM_PATH: iamPath,
      },
      timeout: cdk.Duration.seconds(30),
    });

    routingTable.grantReadWriteData(provisionerFunction);

    provisionerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "iam:CreateUser",
        "iam:DeleteUser",
        "iam:PutUserPolicy",
        "iam:DeleteUserPolicy",
        "iam:CreateAccessKey",
        "iam:ListAccessKeys",
        "iam:DeleteAccessKey",
      ],
      resources: [
        `arn:aws:iam::${this.account}:user${iamPath}*`,
      ],
    }));

    const api = new apigateway.RestApi(this, "AliasProvisioningApi", {
      restApiName: "Email Alias Provisioning",
      description: "API for managing email alias routing and SMTP credentials",
    });

    const aliasesResource = api.root.addResource("aliases");
    const singleAliasResource = aliasesResource.addResource("{email}");
    const provisionerIntegration = new apigateway.LambdaIntegration(provisionerFunction);

    aliasesResource.addMethod("GET", provisionerIntegration, { apiKeyRequired: true });
    aliasesResource.addMethod("POST", provisionerIntegration, { apiKeyRequired: true });
    singleAliasResource.addMethod("GET", provisionerIntegration, { apiKeyRequired: true });
    singleAliasResource.addMethod("DELETE", provisionerIntegration, { apiKeyRequired: true });

    const apiKey = api.addApiKey("ProvisioningApiKey", {
      apiKeyName: "email-provisioning-key",
    });

    const usagePlan = api.addUsagePlan("ProvisioningUsagePlan", {
      name: "email-provisioning-plan",
      throttle: { rateLimit: 10, burstLimit: 10 },
      quota: { limit: 100, period: apigateway.Period.DAY },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    new cdk.CfnOutput(this, "ProvisioningApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "ProvisioningApiKeyId", {
      value: apiKey.keyId,
      description: "Retrieve the key value with: aws apigateway get-api-key --api-key <id> --include-value",
    });

    // 5. PER-DOMAIN RESOURCES
    domains.forEach((config) => {
        const { domainName, hostedZoneId } = config;
        const safeDomainName = domainName.replace(/\./g, "-");

        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `HostedZone-${safeDomainName}`, {
          hostedZoneId: hostedZoneId,
          zoneName: domainName,
        });

        // Identity verification
        new ses.EmailIdentity(this, `EmailIdentity-${safeDomainName}`, {
          identity: ses.Identity.publicHostedZone(hostedZone),
        });

        // Explicitly add MX records since they are missing
        new route53.MxRecord(this, `SesMxRecord-${safeDomainName}`, {
          zone: hostedZone,
          values: [
            {
              priority: 10,
              hostName: `inbound-smtp.${this.region}.amazonaws.com`,
            },
          ],
        });

        ruleSet.addRule(`ForwardRule-${safeDomainName}`, {
          recipients: [domainName],
          actions: [
            new actions.S3({ bucket }),
            new actions.Lambda({ function: forwarderFunction }),
          ],
          enabled: true,
          scanEnabled: true,
        });

        if (config.aliases) {
          for (const [localPart] of Object.entries(config.aliases)) {
            const safeAlias = localPart.replace(/[^a-zA-Z0-9]/g, "-");
            const aliasAddress = `${localPart}@${domainName}`;

            const aliasUser = new iam.User(this, `SmtpUser-${safeDomainName}-${safeAlias}`);
            aliasUser.addToPolicy(new iam.PolicyStatement({
              actions: ["ses:SendRawEmail"],
              resources: ["*"],
              conditions: { StringEquals: { "ses:FromAddress": aliasAddress } },
            }));

            const aliasKey = new iam.AccessKey(this,
              `SmtpAccessKey-${safeDomainName}-${safeAlias}`, { user: aliasUser });

            new cdk.CfnOutput(this, `SmtpKeyId-${safeDomainName}-${safeAlias}`,
              { value: aliasKey.accessKeyId });
            new cdk.CfnOutput(this, `SmtpSecretKey-${safeDomainName}-${safeAlias}`,
              { value: aliasKey.secretAccessKey.unsafeUnwrap() });
          }
        }
    });

    // 3. EXTRACTOR SERVICE USER (for EC2 Docker service polling SQS)
    const extractorUser = new iam.User(this, "ExtractorServiceUser");
    extractorUser.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [extractionQueue.queueArn],
    }));
    extractorUser.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [bucket.arnForObjects("*")],
    }));

    const extractorKey = new iam.AccessKey(this, "ExtractorAccessKey", { user: extractorUser });

    new cdk.CfnOutput(this, "SqsQueueUrl", { value: extractionQueue.queueUrl });
    new cdk.CfnOutput(this, "ExtractorAccessKeyId", { value: extractorKey.accessKeyId });
    new cdk.CfnOutput(this, "ExtractorSecretAccessKey", { value: extractorKey.secretAccessKey.unsafeUnwrap() });

    // 4. SMTP USER
    const smtpUser = new iam.User(this, "SmtpUser");
    smtpUser.addToPolicy(new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
    }));

    const accessKey = new iam.AccessKey(this, "SmtpAccessKey", { user: smtpUser });

    new cdk.CfnOutput(this, "RuleSetActivationCommand", {
      value: `aws ses set-active-receipt-rule-set --rule-set-name ${ruleSet.receiptRuleSetName}`,
    });
    new cdk.CfnOutput(this, "SmtpAccessKeyId", { value: accessKey.accessKeyId });
    new cdk.CfnOutput(this, "SmtpSecretAccessKey", { value: accessKey.secretAccessKey.unsafeUnwrap() });
  }
}

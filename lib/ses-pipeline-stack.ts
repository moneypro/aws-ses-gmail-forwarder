import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as actions from "aws-cdk-lib/aws-ses-actions";
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

    // 1. SHARED RESOURCES
    const bucket = new s3.Bucket(this, "InboundMailBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
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
      },
      timeout: cdk.Duration.seconds(30),
    });

    bucket.grantRead(forwarderFunction);
    forwarderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    // 2. PER-DOMAIN RESOURCES
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

    // 3. SMTP USER
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

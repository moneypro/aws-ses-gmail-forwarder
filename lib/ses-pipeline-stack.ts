import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import * as path from "path";

export class SesPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get configuration from context
    const domainName = this.node.tryGetContext("domainName");
    const destinationEmail = this.node.tryGetContext("destinationEmail");
    const hostedZoneId = this.node.tryGetContext("hostedZoneId");

    if (!domainName || !destinationEmail || !hostedZoneId) {
      throw new Error(
        "Missing required context variables: domainName, destinationEmail, hostedZoneId. " +
        "Provide them via cdk.json or -c key=value"
      );
    }

    const forwardFrom = `forwarder@${domainName}`;

    // 1. Reference existing Route 53 Hosted Zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: hostedZoneId,
      zoneName: domainName,
    });

    // 2. SES Email Identity (for domain verification and DKIM)
    const emailIdentity = new ses.EmailIdentity(this, "EmailIdentity", {
      identity: ses.Identity.publicHostedZone(hostedZone),
    });

    // 3. Add MX record for SES Inbound
    new route53.MxRecord(this, "SesMxRecord", {
      zone: hostedZone,
      values: [
        {
          priority: 10,
          hostName: `inbound-smtp.${this.region}.amazonaws.com`,
        },
      ],
    });

    // 4. S3 Bucket for Inbound Mail Storage
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
          StringEquals: {
            "aws:Referer": this.account,
          },
        },
      })
    );

    // 5. Lambda Forwarder Function
    const forwarderFunction = new lambda.Function(this, "EmailForwarder", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      environment: {
        S3_BUCKET: bucket.bucketName,
        DESTINATION_EMAIL: destinationEmail,
        FORWARD_FROM: forwardFrom,
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

    // 6. SES Receipt Rule Set and Rule
    const ruleSet = new ses.ReceiptRuleSet(this, "RuleSet", {
      dropSpam: true,
    });

    ruleSet.addRule("ForwardToLambda", {
      recipients: [domainName],
      actions: [
        new actions.S3({
          bucket: bucket,
        }),
        new actions.Lambda({
          function: forwarderFunction,
        }),
      ],
      enabled: true,
      scanEnabled: true,
    });

    new cdk.CfnOutput(this, "RuleSetCommand", {
      value: `aws ses set-active-receipt-rule-set --rule-set-name ${ruleSet.receiptRuleSetName}`,
    });

    // 7. IAM User for SMTP
    const smtpUser = new iam.User(this, "SmtpUser");
    smtpUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    const accessKey = new iam.AccessKey(this, "SmtpAccessKey", { user: smtpUser });

    new cdk.CfnOutput(this, "SmtpAccessKeyId", { value: accessKey.accessKeyId });
    new cdk.CfnOutput(this, "SmtpSecretAccessKey", {
      value: accessKey.secretAccessKey.unsafeUnwrap(),
    });
  }
}

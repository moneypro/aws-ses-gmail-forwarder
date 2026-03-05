# AWS SES Gmail Forwarder

A serverless email pipeline built with AWS CDK that forwards all incoming emails for a custom domain to a personal Gmail address. It also sets up an IAM user for SMTP so you can send emails from Gmail using your custom domain.

## Features
- **Catch-all Forwarding:** Forwards `anything@yourdomain.com` to your personal Gmail.
- **Header Rewriting:** Maintains original sender names and fixes Gmail threading issues.
- **Infrastructure as Code:** Fully automated setup using AWS CDK (TypeScript).
- **SMTP Support:** Generates credentials to "Send Mail As" in Gmail.

## Prerequisites
- An AWS account and the [AWS CLI](https://aws.amazon.com/cli/) configured.
- A domain managed in **Route 53**.
- [Node.js](https://nodejs.org/) installed.

## Setup & Deployment

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd aws-ses-gmail-forwarder
   ```

2. **Configure your domain:**
   Edit `cdk.json` and update the `context` section with your details:
   ```json
   "context": {
     "domainName": "yourdomain.com",
     "destinationEmail": "yourname@gmail.com",
     "hostedZoneId": "Z0123456789ABCDEF"
   }
   ```

3. **Deploy:**
   ```bash
   npm install
   npx cdk bootstrap
   npx cdk deploy
   ```

4. **Verify your Gmail address in SES:**
   Because of the SES Sandbox, you must manually verify your destination Gmail address in the [SES Console](https://console.aws.amazon.com/ses/home#/verified-identities) before forwarding will work.

5. **Activate Receipt Rule Set:**
   After deployment, run the activation command provided in the CDK outputs:
   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name <RuleSetName>
   ```

## Sending Email (SMTP)
The stack outputs `SmtpAccessKeyId` and `SmtpSecretAccessKey`. Use these to generate an SMTP password for Gmail.

**Generate SMTP Password:**
```bash
python3 -c "import hmac, hashlib, base64; secret='YOUR_SECRET_KEY'; msg='SendRawEmail'; ver=b'\x02'; sig=hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest(); print(base64.b64encode(ver + sig).decode())"
```

In Gmail Settings > Accounts and Import > Add another email address:
- **SMTP Server:** `email-smtp.us-west-2.amazonaws.com` (or your region)
- **Port:** 587
- **Username:** `SmtpAccessKeyId`
- **Password:** (The generated SMTP Password)

## License
MIT

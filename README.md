# AWS SES Email Forwarder & Provisioning API

A serverless email pipeline built with AWS CDK that forwards incoming emails for custom domains to personal inboxes, with a REST API for dynamically managing aliases and SMTP credentials.

## Features

- **Multi-Domain Forwarding:** Route emails across multiple domains with per-alias destination mapping.
- **Dynamic Alias Provisioning:** REST API to create/delete aliases on the fly without redeploying.
- **SMTP Credential Generation:** Automatically creates IAM SMTP users and derives Gmail-compatible SMTP passwords.
- **DynamoDB Routing:** Alias lookups via DynamoDB with static env-var fallback for resilience.
- **Header Rewriting:** Maintains original sender names, sets Reply-To, and fixes Gmail threading.
- **API Key Authentication:** Provisioning API secured with API Gateway usage plans.
- **Infrastructure as Code:** Fully automated with AWS CDK (TypeScript).

## Architecture

```
Inbound Email
  │
  ▼
SES Receipt Rule → S3 (store) → Forwarder Lambda
  │                                  │
  │                         DynamoDB (routing lookup)
  │                                  │
  │                         SES SendRawEmail → Personal inbox
  │
  └──► SQS (extraction queue for downstream processing)

REST API Gateway (API key auth)
  │
  ▼
Provisioning Lambda
  ├──► DynamoDB (read/write routing entries)
  └──► IAM (create/delete SMTP users)
```

## Prerequisites

- AWS account with the [AWS CLI](https://aws.amazon.com/cli/) configured
- Domain(s) managed in **Route 53**
- [Node.js](https://nodejs.org/) 20+
- CDK bootstrapped (`npx cdk bootstrap`)

## Setup & Deployment

1. **Clone and install:**
   ```bash
   git clone <your-repo-url>
   cd aws-ses-gmail-forwarder
   npm install
   ```

2. **Configure domains in `cdk.json`:**
   ```json
   "context": {
     "destinationEmail": "default-fallback@gmail.com",
     "domains": [
       {
         "domainName": "yourdomain.com",
         "hostedZoneId": "Z0123456789ABCDEF",
         "aliases": {
           "admin": "admin-personal@gmail.com",
           "support": "support-personal@gmail.com"
         }
       }
     ]
   }
   ```

3. **Deploy:**
   ```bash
   npx cdk deploy
   ```

4. **Activate the receipt rule set** (one-time, printed in deploy output):
   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name <RuleSetName>
   ```

5. **Seed existing aliases into DynamoDB** (one-time):
   ```bash
   ROUTING_TABLE_NAME=<table-name-from-output> node scripts/seed-dynamodb.mjs
   ```

6. **Retrieve the API key** (printed as `ProvisioningApiKeyId` in deploy output):
   ```bash
   aws apigateway get-api-key --api-key <key-id> --include-value --query 'value' --output text
   ```

## Provisioning API

Manage aliases dynamically without redeploying. All endpoints require the `x-api-key` header.

### Create alias
```bash
curl -X POST https://<api-url>/aliases \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@yourdomain.com", "destination": "personal@gmail.com"}'
```

Returns the alias details and SMTP credentials for Gmail "Send mail as" setup.

### List aliases
```bash
curl https://<api-url>/aliases -H "x-api-key: <key>"
```

### Get alias (with SMTP credentials)
```bash
curl https://<api-url>/aliases/user%40yourdomain.com -H "x-api-key: <key>"
```

### Delete alias
```bash
curl -X DELETE https://<api-url>/aliases/user%40yourdomain.com -H "x-api-key: <key>"
```

CDK-managed aliases (seeded from `cdk.json`) cannot be deleted via the API.

## Gmail "Send Mail As" Setup

When you create an alias via the API, it returns SMTP credentials. Use them in Gmail:

1. Gmail Settings > Accounts and Import > "Add another email address"
2. Enter the alias email, uncheck "Treat as an alias"
3. SMTP settings:
   - **Server:** `email-smtp.<region>.amazonaws.com`
   - **Port:** `587`
   - **Username:** (from API response)
   - **Password:** (from API response)
   - **Security:** TLS
4. Verify via the confirmation email forwarded to your inbox.

## Routing Precedence

The forwarder Lambda resolves destinations in this order:

1. **DynamoDB** — checked first for all aliases (both API-managed and CDK-seeded)
2. **ROUTING_MAP env var** — static fallback from `cdk.json` aliases
3. **Default destination** — the `destinationEmail` from context

## Known Issues

- **Gmail Threading:** Gmail may not perfectly thread forwarded messages because SES replaces the original `Message-ID`. This is a known SES limitation.
- **IAM Propagation:** After creating an alias via the API, SMTP credentials may take a few seconds to become usable.

## License

MIT

import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { IAMClient, CreateUserCommand, DeleteUserCommand, PutUserPolicyCommand, DeleteUserPolicyCommand, CreateAccessKeyCommand, ListAccessKeysCommand, DeleteAccessKeyCommand } from "@aws-sdk/client-iam";
import { createHmac } from "node:crypto";

const dynamo = new DynamoDBClient({});
const iam = new IAMClient({});

const TABLE_NAME = process.env.ROUTING_TABLE_NAME;
const REGION = process.env.AWS_SES_REGION;
const IAM_PATH = process.env.IAM_PATH || "/ses-provisioner/";
const SMTP_POLICY_NAME = "ses-send-raw-email";

function deriveSmtpPassword(secretAccessKey, region) {
    let sig = createHmac("sha256", "AWS4" + secretAccessKey).update("11111111").digest();
    for (const msg of [region, "ses", "aws4_request", "SendRawEmail"]) {
        sig = createHmac("sha256", sig).update(msg).digest();
    }
    return Buffer.from(Uint8Array.of(0x04, ...sig)).toString("base64");
}

function sanitizeForIamUserName(email) {
    return "smtp-" + email.replace(/@/g, "-at-").replace(/[^a-zA-Z0-9._=@+-]/g, "-");
}

function response(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

async function createAlias(body) {
    const { email, destination } = body;
    if (!email || !destination || !email.includes("@")) {
        return response(400, { error: "Request body must include valid 'email' and 'destination'" });
    }

    // Check if alias already exists
    const existing = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { email: { S: email } },
    }));
    if (existing.Item) {
        return response(409, { error: `Alias '${email}' already exists` });
    }

    const iamUserName = sanitizeForIamUserName(email);

    // Create IAM user for SMTP
    await iam.send(new CreateUserCommand({ UserName: iamUserName, Path: IAM_PATH }));

    // Attach SES send policy scoped to this address
    await iam.send(new PutUserPolicyCommand({
        UserName: iamUserName,
        PolicyName: SMTP_POLICY_NAME,
        PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: "ses:SendRawEmail",
                Resource: "*",
                Condition: { StringEquals: { "ses:FromAddress": email } },
            }],
        }),
    }));

    // Create access key
    const keyResult = await iam.send(new CreateAccessKeyCommand({ UserName: iamUserName }));
    const accessKeyId = keyResult.AccessKey.AccessKeyId;
    const secretAccessKey = keyResult.AccessKey.SecretAccessKey;

    // Derive SMTP password
    const smtpPassword = deriveSmtpPassword(secretAccessKey, REGION);

    // Write routing entry to DynamoDB
    await dynamo.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
            email: { S: email },
            destination: { S: destination },
            iamUserName: { S: iamUserName },
            smtpAccessKeyId: { S: accessKeyId },
            smtpPassword: { S: smtpPassword },
            managedBy: { S: "api" },
            createdAt: { S: new Date().toISOString() },
        },
    }));

    return response(201, {
        email,
        destination,
        managedBy: "api",
        smtp: {
            server: `email-smtp.${REGION}.amazonaws.com`,
            port: 587,
            username: accessKeyId,
            password: smtpPassword,
            security: "TLS",
        },
    });
}

async function deleteAlias(email) {
    const result = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { email: { S: email } },
    }));

    if (!result.Item) {
        return response(404, { error: `Alias '${email}' not found` });
    }

    if (result.Item.managedBy?.S === "cdk") {
        return response(403, { error: "Cannot delete CDK-managed aliases through the API. Remove from cdk.json and redeploy." });
    }

    const iamUserName = result.Item.iamUserName?.S;
    if (iamUserName) {
        // Delete access keys first
        try {
            const keys = await iam.send(new ListAccessKeysCommand({ UserName: iamUserName }));
            for (const key of keys.AccessKeyMetadata || []) {
                await iam.send(new DeleteAccessKeyCommand({ UserName: iamUserName, AccessKeyId: key.AccessKeyId }));
            }
        } catch (err) {
            console.error("Failed to delete access keys:", err);
        }

        // Delete policy then user
        try {
            await iam.send(new DeleteUserPolicyCommand({ UserName: iamUserName, PolicyName: SMTP_POLICY_NAME }));
        } catch (err) {
            console.error("Failed to delete user policy:", err);
        }

        try {
            await iam.send(new DeleteUserCommand({ UserName: iamUserName }));
        } catch (err) {
            console.error("Failed to delete IAM user:", err);
        }
    }

    await dynamo.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { email: { S: email } },
    }));

    return response(200, { message: `Alias '${email}' deleted` });
}

async function listAliases() {
    const result = await dynamo.send(new ScanCommand({ TableName: TABLE_NAME }));
    const aliases = (result.Items || []).map(item => ({
        email: item.email?.S,
        destination: item.destination?.S,
        managedBy: item.managedBy?.S || "unknown",
        createdAt: item.createdAt?.S,
    }));
    return response(200, { aliases });
}

async function getAlias(email) {
    const result = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { email: { S: email } },
    }));

    if (!result.Item) {
        return response(404, { error: `Alias '${email}' not found` });
    }

    const item = result.Item;
    const body = {
        email: item.email?.S,
        destination: item.destination?.S,
        managedBy: item.managedBy?.S || "unknown",
        createdAt: item.createdAt?.S,
    };

    // Include SMTP details if API-managed (has credentials stored)
    if (item.smtpAccessKeyId?.S) {
        body.smtp = {
            server: `email-smtp.${REGION}.amazonaws.com`,
            port: 587,
            username: item.smtpAccessKeyId.S,
            password: item.smtpPassword?.S,
            security: "TLS",
        };
    }

    return response(200, body);
}

export const handler = async (event) => {
    const method = event.httpMethod;
    const resource = event.resource;

    try {
        if (resource === "/aliases" && method === "GET") {
            return await listAliases();
        }
        if (resource === "/aliases" && method === "POST") {
            const body = JSON.parse(event.body || "{}");
            return await createAlias(body);
        }
        if (resource === "/aliases/{email}" && method === "GET") {
            const email = decodeURIComponent(event.pathParameters.email);
            return await getAlias(email);
        }
        if (resource === "/aliases/{email}" && method === "DELETE") {
            const email = decodeURIComponent(event.pathParameters.email);
            return await deleteAlias(email);
        }
        return response(404, { error: "Not found" });
    } catch (err) {
        console.error("Provisioner error:", err);
        return response(500, { error: err.message });
    }
};

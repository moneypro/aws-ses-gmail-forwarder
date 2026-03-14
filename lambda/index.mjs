import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const s3 = new S3Client({});
const ses = new SESClient({});
const sqsClient = new SQSClient({});

export const handler = async (event) => {
    const record = event.Records[0].ses;
    const messageId = record.mail.messageId;
    const bucketName = process.env.S3_BUCKET;
    const destinationEmail = process.env.DESTINATION_EMAIL;
    const routingMap = JSON.parse(process.env.ROUTING_MAP || "{}");

    // Dynamically pick the sender address based on where the email was sent
    // e.g. if sent to admin@aqua-iot.com, we forward from admin@aqua-iot.com
    const forwardFrom = record.mail.destination[0];
    const resolvedDestination = routingMap[forwardFrom] ?? destinationEmail;

    try {
        const getObjectResponse = await s3.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: messageId
        }));

        const rawEmail = await getObjectResponse.Body.transformToString();
        const headerEndIndex = rawEmail.indexOf("\r\n\r\n");
        const headersPart = rawEmail.substring(0, headerEndIndex);
        const bodyPart = rawEmail.substring(headerEndIndex);

        const headerLines = headersPart.split(/\r?\n/);
        const processedHeaders = [];
        
        let originalFrom = record.mail.commonHeaders.from[0];
        let skipFolding = false;

        for (let i = 0; i < headerLines.length; i++) {
            let line = headerLines[i];
            
            if (/^\s/.test(line)) {
                if (skipFolding) continue;
                processedHeaders.push(line);
                continue;
            }

            const lowerLine = line.toLowerCase();
            skipFolding = false;

            if (lowerLine.startsWith("from:")) {
                let fromName = "";
                const nameMatch = line.match(/^From: (.*)<.*>/i);
                if (nameMatch) fromName = nameMatch[1].trim().replace(/"/g, '');
                const cleanName = fromName ? `"${fromName} (via SES)" ` : "";
                
                processedHeaders.push(`From: ${cleanName}<${forwardFrom}>`);
                processedHeaders.push(`Reply-To: ${originalFrom}`);
                continue;
            }

            if (lowerLine.startsWith("to:")) {
                processedHeaders.push(`To: ${resolvedDestination}`);
                continue;
            }

            if (lowerLine.startsWith("return-path:") || 
                lowerLine.startsWith("dkim-signature:") ||
                lowerLine.startsWith("sender:") ||
                lowerLine.startsWith("x-ses-receipt:") ||
                lowerLine.startsWith("x-forwarded-to:") ||
                lowerLine.startsWith("delivered-to:") ||
                lowerLine.startsWith("reply-to:")) {
                skipFolding = true;
                continue;
            }

            processedHeaders.push(line);
        }

        const newRawEmail = processedHeaders.join("\r\n") + bodyPart;

        await ses.send(new SendRawEmailCommand({
            RawMessage: {
                Data: Buffer.from(newRawEmail)
            }
        }));

        // Publish to SQS for email extraction (non-blocking)
        try {
            await sqsClient.send(new SendMessageCommand({
                QueueUrl: process.env.SQS_QUEUE_URL,
                MessageBody: JSON.stringify({
                    s3Bucket: bucketName,
                    s3Key: messageId,
                    recipient: forwardFrom,
                    subject: record.mail.commonHeaders.subject,
                    timestamp: record.mail.timestamp,
                }),
            }));
        } catch (sqsErr) {
            console.error("SQS publish failed (non-fatal):", sqsErr);
        }

        return { status: "success" };
    } catch (err) {
        console.error("Forwarding Error:", err);
        throw err;
    }
};

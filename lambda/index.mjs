import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";

const s3 = new S3Client({});
const ses = new SESClient({});

export const handler = async (event) => {
    const record = event.Records[0].ses;
    const messageId = record.mail.messageId;
    const bucketName = process.env.S3_BUCKET;
    const destinationEmail = process.env.DESTINATION_EMAIL;
    const forwardFrom = record.mail.destination[0];

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
        
        // We will build a new list of headers, specifically preserving 
        // In-Reply-To and References while strictly replacing From/To.
        
        let originalFrom = record.mail.commonHeaders.from[0];
        let skipFolding = false;

        for (let i = 0; i < headerLines.length; i++) {
            let line = headerLines[i];
            
            // Handle folding: if line starts with whitespace, it belongs to the previous header
            if (/^\s/.test(line)) {
                if (skipFolding) continue;
                processedHeaders.push(line);
                continue;
            }

            const lowerLine = line.toLowerCase();
            skipFolding = false;

            // 1. Rewrite FROM
            if (lowerLine.startsWith("from:")) {
                // Try to keep the display name
                let fromName = "";
                const nameMatch = line.match(/^From: (.*)<.*>/i);
                if (nameMatch) fromName = nameMatch[1].trim().replace(/"/g, '');
                const cleanName = fromName ? `"${fromName} (via SES)" ` : "";
                
                processedHeaders.push(`From: ${cleanName}<${forwardFrom}>`);
                processedHeaders.push(`Reply-To: ${originalFrom}`);
                continue;
            }

            // 2. Rewrite TO
            if (lowerLine.startsWith("to:")) {
                processedHeaders.push(`To: ${destinationEmail}`);
                continue;
            }

            // 3. STRIP headers that cause SES conflicts or double-delivery
            if (lowerLine.startsWith("return-path:") || 
                lowerLine.startsWith("dkim-signature:") ||
                lowerLine.startsWith("sender:") ||
                lowerLine.startsWith("x-ses-receipt:") ||
                lowerLine.startsWith("x-forwarded-to:") ||
                lowerLine.startsWith("delivered-to:") ||
                lowerLine.startsWith("reply-to:")) {
                skipFolding = true; // Skip this header and any folded lines following it
                continue;
            }

            // 4. KEEP everything else (In-Reply-To, References, Subject, Message-ID, etc.)
            processedHeaders.push(line);
        }

        const newRawEmail = processedHeaders.join("\r\n") + bodyPart;

        await ses.send(new SendRawEmailCommand({
            RawMessage: {
                Data: Buffer.from(newRawEmail)
            }
        }));

        return { status: "success" };
    } catch (err) {
        console.error("Forwarding Error:", err);
        throw err;
    }
};

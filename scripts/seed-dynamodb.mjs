#!/usr/bin/env node
/**
 * One-time seed script: populates the DynamoDB routing table with existing
 * aliases from cdk.json so the forwarder Lambda can resolve them via DynamoDB.
 *
 * Usage:
 *   ROUTING_TABLE_NAME=<table-name> node scripts/seed-dynamodb.mjs
 *
 * These entries are marked managedBy: "cdk" so the provisioning API will
 * refuse to delete them (they're still owned by the CDK stack).
 *
 * Requires: @aws-sdk/client-dynamodb (install via: npm install @aws-sdk/client-dynamodb)
 * Or run from the Lambda runtime where it's available.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TABLE_NAME = process.env.ROUTING_TABLE_NAME;

if (!TABLE_NAME) {
    console.error("Error: ROUTING_TABLE_NAME environment variable is required");
    process.exit(1);
}

const cdkJson = JSON.parse(readFileSync(join(__dirname, "../cdk.json"), "utf-8"));
const domains = cdkJson.context.domains || [];
const defaultDest = cdkJson.context.destinationEmail;

let seeded = 0;
let skipped = 0;

function putItem(email, destination) {
    const item = JSON.stringify({
        email: { S: email },
        destination: { S: destination },
        managedBy: { S: "cdk" },
        createdAt: { S: new Date().toISOString() },
    });

    try {
        execSync(`aws dynamodb put-item --table-name "${TABLE_NAME}" --item '${item}' --condition-expression "attribute_not_exists(email)"`, {
            stdio: "pipe",
        });
        console.log(`  Seeded: ${email} -> ${destination}`);
        seeded++;
    } catch (err) {
        if (err.stderr?.toString().includes("ConditionalCheckFailedException")) {
            console.log(`  Skipped (exists): ${email}`);
            skipped++;
        } else {
            console.error(`  Error seeding ${email}:`, err.stderr?.toString());
            throw err;
        }
    }
}

for (const domain of domains) {
    if (domain.aliases) {
        for (const [localPart, destination] of Object.entries(domain.aliases)) {
            putItem(`${localPart}@${domain.domainName}`, destination);
        }
    }
}

console.log(`\nDone. Seeded: ${seeded}, Skipped: ${skipped}`);

#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SesPipelineStack } from '../lib/ses-pipeline-stack';

const app = new cdk.App();
new SesPipelineStack(app, 'SesPipelineStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

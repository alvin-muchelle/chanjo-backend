#!/usr/bin/env node
/**
 * batchMigrateOnDemandSchemas.mjs
 *
 * Migrate (schema‑only) an array of empty, on‑demand DynamoDB tables from
 * one AWS account to another. This version assumes ALL tables have
 * BillingMode = PAY_PER_REQUEST, so it omits any ProvisionedThroughput logic.
 *
 * Usage:
 *   node batchMigrateOnDemandSchemas.mjs \
 *     --source-profile sourceAccountProfile \
 *     --dest-profile destAccountProfile \
 *     [--region us-east-1]
 *
 * It will process these table names:
 *   - babies
 *   - mothers
 *   - reminders
 *   - vaccination_schedule
 */

import { DynamoDBClient,
         DescribeTableCommand,
         ListTagsOfResourceCommand,
         DescribeTimeToLiveCommand,
         DescribeContinuousBackupsCommand,
         CreateTableCommand,
         UpdateTimeToLiveCommand,
         UpdateContinuousBackupsCommand,
         waitUntilTableExists } from "@aws-sdk/client-dynamodb";

import { fromIni } from "@aws-sdk/credential-provider-ini";
import yargsPkg from "yargs";
import { hideBin } from "yargs/helpers";
import process from "process";

// ——— CLI Argument Parsing ———
const argv = yargsPkg(hideBin(process.argv))
  .option("source-profile", { type: "string", demandOption: true })
  .option("dest-profile",   { type: "string", demandOption: true })
  .option("region",         { type: "string", default: "us-east-1" })
  .help()
  .alias("help", "h")
  .parse();

const SOURCE_PROFILE = argv["source-profile"];
const DEST_PROFILE   = argv["dest-profile"];
const REGION         = argv["region"];

// ——— List of tables to migrate ———
const TABLES_TO_MIGRATE = [
  "babies",
  "mothers",
  "reminders",
  "vaccination_schedule",
];

// ——— Helper: Build schema from a source table ———
async function getTableSchema(ddbClient, tableName) {
  const { Table } = await ddbClient.send(
    new DescribeTableCommand({ TableName: tableName })
  );
  if (!Table) {
    throw new Error(`Table "${tableName}" not found in source account.`);
  }

  // We know BillingMode is on‑demand, so we hardcode PAY_PER_REQUEST.
  // We still copy KeySchema, AttributeDefinitions, indexes, streams, etc.
  const schema = {
    TableName: Table.TableName,
    AttributeDefinitions: Table.AttributeDefinitions,
    KeySchema: Table.KeySchema,
    BillingMode: "PAY_PER_REQUEST",
  };

  // 1) Global Secondary Indexes (if any)
  if (Array.isArray(Table.GlobalSecondaryIndexes)) {
    schema.GlobalSecondaryIndexes = Table.GlobalSecondaryIndexes.map((gsi) => ({
      IndexName:  gsi.IndexName,
      KeySchema:  gsi.KeySchema,
      Projection: gsi.Projection,
      // On‑demand GSIs don’t need ProvisionedThroughput either
    }));
  }

  // 2) Local Secondary Indexes (if any)
  if (Array.isArray(Table.LocalSecondaryIndexes)) {
    schema.LocalSecondaryIndexes = Table.LocalSecondaryIndexes.map((lsi) => ({
      IndexName:  lsi.IndexName,
      KeySchema:  lsi.KeySchema,
      Projection: lsi.Projection,
    }));
  }

  // 3) StreamSpecification (if enabled)
  if (Table.StreamSpecification?.StreamEnabled) {
    schema.StreamSpecification = {
      StreamEnabled: true,
      StreamViewType: Table.StreamSpecification.StreamViewType,
    };
  }

  // 4) SSESpecification (if enabled)
  if (Table.SSEDescription?.Status === "ENABLED") {
    schema.SSESpecification = {
      Enabled: true,
      SSEType: Table.SSEDescription.SSEType, // usually "KMS"
      // If you used a custom CMK, add KMSMasterKeyId here.
      // KMSMasterKeyId: "<your‑kms‑key‑arn>"
    };
  }

  // 5) Tags (optional)
  const tagsResp = await ddbClient.send(
    new ListTagsOfResourceCommand({ ResourceArn: Table.TableArn })
  );
  if (Array.isArray(tagsResp.Tags) && tagsResp.Tags.length) {
    schema.Tags = tagsResp.Tags.map((t) => ({ Key: t.Key, Value: t.Value }));
  }

  // 6) TimeToLive (post‑creation)
  const ttlResp = await ddbClient.send(
    new DescribeTimeToLiveCommand({ TableName: tableName })
  );
  const ttlDesc = ttlResp.TimeToLiveDescription;
  if (ttlDesc?.TimeToLiveStatus === "ENABLED") {
    schema._EnableTTL = {
      Enabled: true,
      AttributeName: ttlDesc.AttributeName,
    };
  }

  // 7) Point‑In‑Time Recovery (post‑creation)
  const pitrResp = await ddbClient.send(
    new DescribeContinuousBackupsCommand({ TableName: tableName })
  );
  const pitrDesc = pitrResp.ContinuousBackupsDescription
    .PointInTimeRecoveryDescription;
  if (pitrDesc?.PointInTimeRecoveryStatus === "ENABLED") {
    schema._EnablePITR = true;
  }

  return schema;
}

// ——— Helper: Create table in destination + enable TTL/PITR ———
async function createTableInDest(ddbClient, schema, destTableName) {
  const createParams = {
    TableName: destTableName,
    AttributeDefinitions: schema.AttributeDefinitions,
    KeySchema: schema.KeySchema,
    BillingMode: "PAY_PER_REQUEST",
  };

  if (Array.isArray(schema.GlobalSecondaryIndexes)) {
    createParams.GlobalSecondaryIndexes = schema.GlobalSecondaryIndexes;
  }
  if (Array.isArray(schema.LocalSecondaryIndexes)) {
    createParams.LocalSecondaryIndexes = schema.LocalSecondaryIndexes;
  }
  if (schema.StreamSpecification) {
    createParams.StreamSpecification = schema.StreamSpecification;
  }
  if (schema.SSESpecification) {
    createParams.SSESpecification = schema.SSESpecification;
  }
  if (Array.isArray(schema.Tags)) {
    createParams.Tags = schema.Tags;
  }

  console.log(`→ Creating table "${destTableName}" in destination account...`);
  try {
    await ddbClient.send(new CreateTableCommand(createParams));
  } catch (err) {
    console.error(`ERROR: Could not create "${destTableName}":`, err);
    process.exit(1);
  }

  console.log(`→ Waiting for "${destTableName}" to become ACTIVE…`);
  await waitUntilTableExists(
    { client: ddbClient, maxWaitTime: 300 },
    { TableName: destTableName }
  );
  console.log(`→ "${destTableName}" is now ACTIVE.`);

  // Enable TTL if needed
  if (schema._EnableTTL) {
    console.log(
      `→ Enabling TTL on "${destTableName}" (attribute="${schema._EnableTTL.AttributeName}")…`
    );
    await ddbClient.send(
      new UpdateTimeToLiveCommand({
        TableName: destTableName,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: schema._EnableTTL.AttributeName,
        },
      })
    );
    console.log("→ TTL enabled.");
  }

  // Enable PITR if needed
  if (schema._EnablePITR) {
    console.log(`→ Enabling Point‑In‑Time Recovery on "${destTableName}"…`);
    await ddbClient.send(
      new UpdateContinuousBackupsCommand({
        TableName: destTableName,
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      })
    );
    console.log("→ PITR enabled.");
  }

  console.log(`✅ Schema for "${destTableName}" created successfully.`);
}

// ——— Main Flow ———
async function main() {
  // 1) Initialize DynamoDB clients for source & destination
  const srcClient = new DynamoDBClient({
    region: REGION,
    credentials: fromIni({ profile: SOURCE_PROFILE }),
  });
  const dstClient = new DynamoDBClient({
    region: REGION,
    credentials: fromIni({ profile: DEST_PROFILE }),
  });

  for (const tableName of TABLES_TO_MIGRATE) {
    console.log(`\n=== Processing table: "${tableName}" ===`);

    // 2) Fetch schema from source
    console.log(`→ Fetching schema for "${tableName}" from source account...`);
    const schema = await getTableSchema(srcClient, tableName);

    // 3) Create table in destination
    await createTableInDest(dstClient, schema, tableName);
  }

  console.log("\n🎉 All four tables have been migrated (schema‑only, PAY_PER_REQUEST).");
}

main().catch((err) => {
  console.error("Fatal error in batch migration:", err);
  process.exit(1);
});

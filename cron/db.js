import dotenv from 'dotenv';
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

dotenv.config();

const REGION = process.env.AWS_REGION || 'us-east-1';
let ddbDocClient = null;

/**
 * Initializes the DynamoDBDocumentClient once, and does a quick ListTables
 * to verify connectivity/credentials. Returns the DocumentClient.
 */
export async function connectDB() {
  if (!ddbDocClient) {
    // 1) Create the low-level client
    const ddbClient = new DynamoDBClient({ region: REGION });
    // 2) Wrap it in the DocumentClient for auto marshalling
    ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

    // Optional sanity check:
    try {
      await ddbClient.send(new ListTablesCommand({ Limit: 1 }));
      console.log(`✅ DynamoDB connected (region: ${REGION})`);
    } catch (err) {
      console.error("⚠️ DynamoDB connection test failed:", err);
      process.exit(1);
    }
  }
  return ddbDocClient;
}

/**
 * Returns the initialized DocumentClient, or throws if not yet initialized.
 */
export function getDB() {
  if (!ddbDocClient) {
    throw new Error("DynamoDB not initialized! Call connectDB() first.");
  }
  return ddbDocClient;
}

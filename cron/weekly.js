// File: cron/weekly.js
import { connectDB, getDB } from "./db.js";
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

let ddb;
const sns = new SNSClient({ region: process.env.AWS_REGION });

async function ensureDbConnected() {
  if (!ddb) {
    await connectDB();
    ddb = getDB();
    console.info("✅ DynamoDB connected (weekly handler)");
  }
}

/**
 * Build a plain‑text email body (no HTML) for weekly reminders.
 */
function buildWeeklyPlainText(fullName, reminders) {
  // All reminders share same vaccination_date, so read from first:
  const vaccDate = new Date(reminders[0].vaccination_date);
  const formattedDate = vaccDate.toDateString(); // e.g. "Wed Jun 11 2025"

  // Build bullet‑list of vaccines
  const bulletList = reminders
    .map(r => `  • ${r.vaccine}`)
    .join("\n");

  return [
    `Dear ${fullName},`,
    ``,
    `Your baby has the following vaccinations due on ${formattedDate}:`,
    ``,
    bulletList,
    ``,
    `Regards,`,
    `Chanjo Team`
  ].join("\n");
}

export const handler = async () => {
  try {
    // 1) ensure DynamoDB is initialized
    await ensureDbConnected();

    const nowISO = new Date().toISOString();

    // 2) Query for any unsent “weekly” reminders whose scheduled_at <= now
    const { Items: dueWeekly = [] } = await ddb.send(new QueryCommand({
      TableName: "reminders",
      IndexName: "ByScheduledAt",
      KeyConditionExpression: "#t = :weekly AND scheduled_at <= :now",
      FilterExpression: "sent = :false",
      ExpressionAttributeNames: { "#t": "type" },
      ExpressionAttributeValues: {
        ":weekly": "weekly",
        ":now": nowISO,
        ":false": "false"
      }
    }));

    if (dueWeekly.length === 0) {
      console.info("No weekly reminders to send.");
      return { statusCode: 200, body: "No weekly reminders." };
    }

    // 3) Group by motherId
    const weeklyByMother = dueWeekly.reduce((acc, r) => {
      if (!acc[r.motherId]) acc[r.motherId] = [];
      acc[r.motherId].push(r);
      return acc;
    }, {});

    // 4) For each motherId, fetch her email & name, publish plain‑text SNS message, then mark sent.
    for (const [motherId, reminders] of Object.entries(weeklyByMother)) {
      const { Item: mother } = await ddb.send(new GetCommand({
        TableName: "mothers",
        Key: { userId: motherId }
      }));
      if (!mother || !mother.email) {
        console.warn(`Mother not found or missing email for ID ${motherId}. Skipping.`);
        continue;
      }

      // Build plain‑text body
      const textBody = buildWeeklyPlainText(mother.full_name, reminders);

      // Publish to SNS topic
      await sns.send(new PublishCommand({
        TopicArn: process.env.SNS_TOPIC_ARN,
        Message: textBody,
        Subject: `Vaccinations due on ${new Date(reminders[0].vaccination_date).toDateString()}`,
        MessageAttributes: {
          // no reserved keys allowed here
        }
      }));

      // Mark each reminder as sent=true
      for (const rem of reminders) {
        await ddb.send(new UpdateCommand({
          TableName: "reminders",
          Key: { reminderId: rem.reminderId },
          UpdateExpression: "SET sent = :true",
          ExpressionAttributeValues: { ":true": "true" }
        }));
      }
    }

    return { statusCode: 200, body: "Weekly reminders processed." };
  } catch (err) {
    console.error("Weekly cron error:", err);
    return { statusCode: 500, body: "Weekly cron failure." };
  }
};

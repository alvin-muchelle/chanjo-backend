/**
 * File: cron/weekly.js
 * Lambda function for processing all due 'weekly' reminders once per week.
 */

import { connectDB, getDB } from './db.js';
import nodemailer from 'nodemailer';
import { SESClient } from '@aws-sdk/client-ses';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

let ddb;  // Will hold the DynamoDB client

// SES‐backed nodemailer transporter (ensure AWS_REGION and EMAIL_FROM are set)
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const transporter = nodemailer.createTransport({ SES: sesClient });

async function ensureDbConnected() {
  if (!ddb) {
    await connectDB();
    ddb = getDB();
    console.info("✅ DynamoDB connected inside weekly handler");
  }
}

// Helper: send combined reminder email via SES
async function sendCombinedReminderEmail(email, fullName, reminders) {
  // All reminders share the same vaccination_date for this mother
  const vaccinationDate = new Date(reminders[0].vaccination_date);
  const formattedDate = vaccinationDate.toDateString();

  const reminderListHtml = reminders
    .map(r => `<li><strong>${r.vaccine}</strong></li>`)
    .join('');

  await transporter.sendMail({
    from: `"Chanjo Chonjo" <${process.env.EMAIL_FROM}>`,
    to: email,
    subject: `Vaccinations due on ${formattedDate}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <p>Dear ${fullName},</p>
        <p>Your baby has the following vaccinations due on ${formattedDate}:</p>
        <ul>${reminderListHtml}</ul>
        <p>Regards,<br/>Chanjo Team</p>
      </div>
    `
  });
}

// Lambda handler
export const handler = async (event) => {
  try {
    // 1) Ensure DynamoDB is connected
    await ensureDbConnected();

    const nowISO = new Date().toISOString();

    // 2) Query all unsent 'weekly' reminders whose scheduled_at <= now
    const { Items: dueWeekly = [] } = await ddb.send(new QueryCommand({
      TableName: 'reminders',
      IndexName: 'ByScheduledAt',
      KeyConditionExpression: '#t = :weekly AND scheduled_at <= :now',
      FilterExpression: 'sent = :false',
      ExpressionAttributeNames: {
        '#t': 'type'
      },
      ExpressionAttributeValues: {
        ':weekly': 'weekly',
        ':now': nowISO,
        ':false': "false"
      }
    }));

    if (dueWeekly.length === 0) {
      console.log('No weekly reminders to send.');
      return { statusCode: 200, body: 'No weekly reminders.' };
    }

    // 3) Group by motherId
    const weeklyByMother = dueWeekly.reduce((acc, r) => {
      if (!acc[r.motherId]) acc[r.motherId] = [];
      acc[r.motherId].push(r);
      return acc;
    }, {});

    // 4) For each mother, fetch her email & name, send combined email, then mark as sent
    for (const [motherId, reminders] of Object.entries(weeklyByMother)) {
      // Fetch mother record
      const { Item: mother } = await ddb.send(new GetCommand({
        TableName: 'mothers',
        Key: { userId: motherId }
      }));
      if (!mother || !email) {
        console.warn(`Mother not found or missing email for ID ${motherId}. Skipping.`);
        continue;
      }

      // Send combined email
      await sendCombinedReminderEmail(email, mother.full_name, reminders);

      // Mark each reminder as sent
      for (const reminder of reminders) {
        await ddb.send(new UpdateCommand({
          TableName: 'reminders',
          Key: { reminderId: reminder.reminderId },
          UpdateExpression: 'SET sent = :true',
          ExpressionAttributeValues: { ':true': "true" }
        }));
      }
    }

    return { statusCode: 200, body: 'Weekly reminders processed.' };
  } catch (err) {
    console.error('Weekly cron error:', err);
    return { statusCode: 500, body: 'Weekly cron failure.' };
  }
};

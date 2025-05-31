/**
 * File: cron/daily.js
 * Lambda function for processing all due 'daily' reminders once per day.
 */

import { connectDB, getDB } from '../db.js';
import nodemailer from 'nodemailer';
import { SESClient } from '@aws-sdk/client-ses';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

// Because parseAgeToDays is not needed here, omitted.

let ddb;
(async () => {
  // Ensure a single DB connection per Lambda container
  await connectDB();
  ddb = getDB();
})();

// SES-based nodemailer transporter
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const transporter = nodemailer.createTransport({ SES: sesClient });

// Helper: send combined reminder email via SES
async function sendCombinedReminderEmail(email, fullName, reminders) {
  // All reminders have the same vaccination_date (since we grouped by scheduled_at==today)
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
        <p>Your baby has these vaccines due on ${formattedDate}:</p>
        <ul>${reminderListHtml}</ul>
        <p>Regards,<br/>Chanjo Team</p>
      </div>
    `
  });
}

// Lambda handler
export const handler = async (event) => {
  try {
    const nowISO = new Date().toISOString();

    // 1) Query all unsent 'daily' reminders whose scheduled_at <= now
    const { Items: dueDaily = [] } = await ddb.send(new QueryCommand({
      TableName: 'reminders',
      IndexName: 'ByScheduledAt',  
      KeyConditionExpression: '#t = :daily AND scheduled_at <= :now',
      FilterExpression: 'sent = :false',
      ExpressionAttributeNames: {
        '#t': 'type'
      },
      ExpressionAttributeValues: {
        ':daily': 'daily',
        ':now': nowISO,
        ':false': "false"
      }
    }));

    if (dueDaily.length === 0) {
      console.log('No daily reminders to send.');
      return { statusCode: 200, body: 'No daily reminders.' };
    }

    // 2) Group by motherId
    const dailyByMother = dueDaily.reduce((acc, r) => {
      if (!acc[r.motherId]) acc[r.motherId] = [];
      acc[r.motherId].push(r);
      return acc;
    }, {});

    // 3) For each mother, fetch her email & name, send combined email, mark as sent
    for (const [motherId, reminders] of Object.entries(dailyByMother)) {
      // Fetch mother record
      const { Item: mother } = await ddb.send(new GetCommand({
        TableName: 'mothers',
        Key: { userId: motherId }
      }));
      if (!mother || !mother.user?.email) {
        console.warn(`Mother not found or missing email for ID ${motherId}. Skipping.`);
        continue;
      }

      // Send combined email
      await sendCombinedReminderEmail(mother.user.email, mother.full_name, reminders);

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

    return { statusCode: 200, body: 'Daily reminders processed.' };
  } catch (err) {
    console.error('Daily cron error:', err);
    return { statusCode: 500, body: 'Daily cron failure.' };
  }
};

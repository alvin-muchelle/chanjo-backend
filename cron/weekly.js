/**
 * File: cron/weekly.js
 * Lambda function for processing all due 'weekly' reminders once per week.
 */

import { connectDB, getDB } from '../db.js';
import nodemailer from 'nodemailer';
import { SESClient } from '@aws-sdk/client-ses';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

// No parseAgeToDays needed here

let ddb;
(async () => {
  await connectDB();
  ddb = getDB();
})();

// SES transporter
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const transporter = nodemailer.createTransport({ SES: sesClient });

// Helper: send combined reminder email via SES
async function sendCombinedReminderEmail(email, fullName, reminders) {
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

    // 1) Query all unsent 'weekly' reminders whose scheduled_at <= now
    const { Items: dueReminders = [] } = await ddb.send(new QueryCommand({
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

    if (dueReminders.length === 0) {
      console.log('No weekly reminders to send.');
      return { statusCode: 200, body: 'No weekly reminders.' };
    }

    // 2) Group by motherId
    const remindersByMother = dueReminders.reduce((acc, r) => {
      if (!acc[r.motherId]) acc[r.motherId] = [];
      acc[r.motherId].push(r);
      return acc;
    }, {});

    // 3) For each mother, fetch email, send combined email, mark as sent
    for (const [motherId, reminders] of Object.entries(remindersByMother)) {
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

    return { statusCode: 200, body: 'Weekly reminders processed.' };
  } catch (err) {
    console.error('Weekly cron error:', err);
    return { statusCode: 500, body: 'Weekly cron failure.' };
  }
};

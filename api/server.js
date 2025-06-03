import dotenv from 'dotenv';
import express from 'express';
import { SNSClient, SubscribeCommand, ListSubscriptionsByTopicCommand} from '@aws-sdk/client-sns';
import { v4 as uuidv4 } from 'uuid';
import { connectDB, getDB } from './db.js';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import serverless from 'serverless-http';
import {
  UpdateCommand,
  GetCommand,
  QueryCommand,
  PutCommand,
  BatchWriteCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";
import {
  Validator,
  ValidationError
} from 'express-json-validator-middleware';
import {
  profileUpdateSchema,
  addBabySchema,
} from './schemas/profile.schema.js';

dotenv.config();

// Create & configure the Express app
const app = express();

// Ensure single DB connection across warm invocations
if (!global.ddb) {
  await connectDB();
  global.ddb = getDB();
}
const ddb = global.ddb;
const { validate } = new Validator({ ajvOptions: { allErrors: true } });

// CORS: allow only your vercel domain or * for testing
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());
// right after `app.use(express.json());`
app.use((req, _res, next) => {
  // if API Gateway sent a base64→Buffer because it thought JSON was binary:
  if (Buffer.isBuffer(req.body)) {
    try {
      const s = req.body.toString('utf8');
      req.body = JSON.parse(s);
    } catch (_) {
      // if it wasn’t valid JSON, leave req.body as is
    }
  }
  next();
});

// Global uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Email setup for sending via Gmail locally. In Lambda, you can switch this to SES.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Helper: send temporary password email
async function sendTemporaryPassword(email, tempPassword) {
  await transporter.sendMail({
    from: `"Chanjo Chonjo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your Temporary Password',
    html: `
      <p>Hello,</p>
      <p>Welcome to Chanjo! Here's your temporary password:</p>
      <p><strong>${tempPassword}</strong></p>
      <p>Please log in and reset your password within 15 minutes.</p>
      <p>Best,<br/>Chanjo Chonjo</p>
    `
  });
}

// Helper: send password‐reset confirmation
async function sendPasswordResetConfirmation(email) {
  await transporter.sendMail({
    from: `"Chanjo Chonjo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your password has been changed",
    html: `
      <p>Hello,</p>
      <p>This is a confirmation that your password was successfully changed.</p>
      <p>If you did not perform this action, please contact support immediately.</p>
      <p>Regards,<br/>Chanjo Chonjo</p>
    `,
  });
}

// parseAgeToDays (same logic as before)
function parseAgeToDays(ageStr) {
  ageStr = ageStr.trim().toLowerCase();
  if (ageStr === 'birth') return 0;
  const unitMap = { week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };
  const rangeRegex = /^(\d+)[–-](\d+)\s*(\w+)$/;
  const singleRegex = /^(\d+)\s*(\w+)$/;
  let match = ageStr.match(rangeRegex);
  if (match) {
    const [, start, end, unit] = match;
    const avg = (parseInt(start, 10) + parseInt(end, 10)) / 2;
    return avg * (unitMap[unit] || 0);
  }
  match = ageStr.match(singleRegex);
  if (match) {
    const [, num, unit] = match;
    return parseInt(num, 10) * (unitMap[unit] || 0);
  }
  return 0;
}

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      console.error('JWT verify error:', err);
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = payload;
    next();
  });
};

// --- Health & Root endpoints ---
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/', (_req, res) => res.status(200).send('Chanjo chonjo backend is running'));

// --- Signup ---
const sns = new SNSClient({ region: 'us-east-1' });

app.post('/api/signup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }

    // 1) Check if user already exists (using a GSI on email)
    const existing = await ddb.send(new QueryCommand({
      TableName: 'mothers',
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (existing.Count > 0) {
      return res.status(409).json({ message: 'User already exists' });
    }

    // 2) Create a temporary password & hash it
    const rawPassword = Math.floor(100000 + Math.random() * 900000).toString();
    const hashed = await bcrypt.hash(rawPassword, 10);
    const userId = uuidv4();

    // 3) Put a new “mother” item into DynamoDB
    await ddb.send(new PutCommand({
      TableName: 'mothers',
      Item: {
        userId,
        email,
        full_name: null,
        babies: [],
        user: {
          hashed_password: hashed,
          must_reset_password: true,
          created_at: new Date().toISOString()
        }
      }
    }));

    // 4) Send temporary password
    await sendTemporaryPassword(email, rawPassword);

    // 5) Issue a short‐lived JWT so they can log in and reset
    const token = jwt.sign(
      { userId, email },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.status(201).json({ message: 'Registered. Check your inbox to confirm SNS subscription.', token });
  }
  catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --- Reset Password ---
app.post('/api/reset-password', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const { newPassword } = req.body;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    await ddb.send(new UpdateCommand({
      TableName: 'mothers',
      Key: { userId },
      UpdateExpression: 'SET #user.#hashed = :hp, #user.#reset = :reset',
      ExpressionAttributeNames: {
        '#user': 'user',
        '#hashed': 'hashed_password',
        '#reset': 'must_reset_password'
      },
      ExpressionAttributeValues: {
        ':hp': newHashedPassword,
        ':reset': false
      }
    }));

    await sendPasswordResetConfirmation(decoded.email);
    res.status(200).json({ message: 'Password updated' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(401).json({ error: 'Invalid token or server error' });
  }
});

// --- Login ---
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { Items } = await ddb.send(new QueryCommand({
      TableName: 'mothers',
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    const mother = Items[0];
    if (!mother) return res.status(400).json({ error: 'User not found' });

    // Compare password
    if (!await bcrypt.compare(password, mother.user.hashed_password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Issue JWT (default expiry or from env)
    const token = jwt.sign(
      { userId: mother.userId, email: mother.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    // Subscribe this email to our SNS topic (protocol="email")
   // Before subscribing, check if this email is already subscribed
    const existingSubs = await sns.send(new ListSubscriptionsByTopicCommand({
      TopicArn: process.env.SNS_TOPIC_ARN
    }));

    const alreadySubscribed = existingSubs.Subscriptions.some(
      (sub) => sub.Protocol === "email" && sub.Endpoint === email
    );

    if (!alreadySubscribed) {
      await sns.send(new SubscribeCommand({
        TopicArn: process.env.SNS_TOPIC_ARN,
        Protocol: 'email',
        Endpoint: email
      }));
    }

    res.json({
      message: 'Login successful',
      token,
      userId: mother.userId,
      mustResetPassword: mother.user.must_reset_password
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Profile Routes ---

// Add/Update profile (mother + optional baby)
app.post(
  '/api/profile',
  authenticateToken,
  validate({ body: profileUpdateSchema }),
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const { fullName, phoneNumber, babyName, dateOfBirth, gender } = req.body;

      // A) Fetch mother to check must_reset_password
      const { Item: mother } = await ddb.send(new GetCommand({
        TableName: 'mothers',
        Key: { userId },
        ProjectionExpression: 'email, #u.#mrp, full_name, phone_number',
        ExpressionAttributeNames: {
          '#u': 'user',
          '#mrp': 'must_reset_password'
        }
      }));
      if (!mother) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      if (mother.user.must_reset_password) {
        return res.status(403).json({
          error: 'Password reset required before updating profile'
        });
      }

      // B) Enforce unique phone (exclude same user)
      const phoneCheck = await ddb.send(new QueryCommand({
        TableName: 'mothers',
        IndexName: 'PhoneNumberIndex',
        KeyConditionExpression: 'phone_number = :pn',
        ExpressionAttributeValues: { ':pn': phoneNumber }
      }));
      if (phoneCheck.Count > 0 && phoneCheck.Items[0].userId !== userId) {
        return res.status(409).json({ error: 'Phone number already in use' });
      }

      // C) Update mother's full_name & phone_number
      await ddb.send(new UpdateCommand({
        TableName: 'mothers',
        Key: { userId },
        UpdateExpression: 'SET full_name = :fn, phone_number = :pn',
        ExpressionAttributeValues: {
          ':fn': fullName,
          ':pn': phoneNumber
        }
      }));

      // D) If no baby fields, we're done
      if (!babyName || !dateOfBirth || !gender) {
        return res.status(200).json({ message: 'Profile updated' });
      }

      // E) Check duplicate baby name under this user
      const { Items: existingBabies = [] } = await ddb.send(new QueryCommand({
        TableName: 'babies',
        IndexName: 'MotherIndex',
        KeyConditionExpression: 'motherUserId = :m',
        ExpressionAttributeValues: { ':m': userId }
      }));
      const duplicate = existingBabies.some(
        b => b.babyName.toLowerCase() === babyName.toLowerCase()
      );
      if (duplicate) {
        return res.status(409).json({ error: 'You already have a baby with that name' });
      }

      // F) Insert new baby
      const babyId = uuidv4();
      await ddb.send(new PutCommand({
        TableName: 'babies',
        Item: {
          babyId,
          babyName,
          motherUserId: userId,
          motherEmail: mother.email,
          dateOfBirth: new Date(dateOfBirth).toISOString(),
          gender
        }
      }));

      return res.status(201).json({
        message: 'Profile updated & baby added successfully',
        baby: { babyId, babyName, dateOfBirth, gender }
      });
    } catch (error) {
      console.error('Profile error:', error);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

// Get profile + babies
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 1) Fetch mother
    const { Item: mother } = await ddb.send(new GetCommand({
      TableName: 'mothers',
      Key: { userId },
      ProjectionExpression: '#u.#mrp, full_name, phone_number',
      ExpressionAttributeNames: {
        '#u': 'user',
        '#mrp': 'must_reset_password'
      }
    }));
    if (!mother) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // 2) Fetch babies
    const { Items: babyItems = [] } = await ddb.send(new QueryCommand({
      TableName: 'babies',
      IndexName: 'MotherIndex',
      KeyConditionExpression: 'motherUserId = :m',
      ExpressionAttributeValues: { ':m': userId }
    }));

    // 3) Format baby data
    const formattedBabies = babyItems.map(b => ({
      id: b.babyId,
      baby_name: b.babyName,
      date_of_birth: b.dateOfBirth.split('T')[0],
      gender: b.gender
    }));

    return res.json({
      mustResetPassword: mother.user.must_reset_password,
      profileComplete: !!mother.full_name && !!mother.phone_number && formattedBabies.length > 0,
      mother: {
        full_name: mother.full_name,
        phone_number: mother.phone_number
      },
      babies: formattedBabies
    });
  } catch (error) {
    console.error('Profile error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --- Baby Birth-Date Adjustment & Reminder Regeneration ---
app.put('/api/baby/:id/birth-date', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const babyId = req.params.id;
    const { birthDate } = req.body;

    // Validate YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return res.status(400).json({ error: 'Use YYYY-MM-DD.' });
    }
    const parsed = new Date(birthDate + 'T00:00:00Z');
    if (isNaN(parsed)) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    const isoDOB = parsed.toISOString();

    // 1) Update baby’s DOB
    await ddb.send(new UpdateCommand({
      TableName: 'babies',
      Key: { babyId },
      UpdateExpression: 'SET dateOfBirth = :dob',
      ExpressionAttributeValues: { ':dob': isoDOB }
    }));

    // 2) Delete existing UNSENT reminders for this baby
    const { Items: existingRems = [] } = await ddb.send(new QueryCommand({
      TableName: 'reminders',
      IndexName: 'ByBaby',
      KeyConditionExpression: 'babyId = :b AND sent = :false',
      ExpressionAttributeValues: {
        ':b': babyId,
        ':false': 'false',
      }
    }));
    const deletes = existingRems.map(r => ({
      DeleteRequest: { Key: { reminderId: r.reminderId } }
    }));
    if (deletes.length) {
      while (deletes.length) {
        const chunk = deletes.splice(0, 25);
        await ddb.send(new BatchWriteCommand({
          RequestItems: { reminders: chunk }
        }));
      }
    }

    // 3) Recompute & batch‐write new reminders
    const now = new Date();
    const remindersToInsert = [];
    const { Items: schedule = [] } = await ddb.send(new ScanCommand({
      TableName: 'vaccination_schedule'
    }));

    for (let { age, vaccine } of schedule) {
      const daysOffset = parseAgeToDays(age);
      const vacDate = new Date(parsed);
      vacDate.setDate(parsed.getDate() + daysOffset);

      // Skip if vacDate is in the past
      if (vacDate <= now) {
        continue;
      }

      // Compute diffDays
      const msPerDay = 1000 * 60 * 60 * 24;
      const diffDays = (vacDate.getTime() - now.getTime()) / msPerDay;

      // Weekly reminder if ≥7 days away
      if (diffDays >= 7) {
        const weeklyRem = new Date(vacDate);
        weeklyRem.setDate(vacDate.getDate() - 7);
        weeklyRem.setHours(14, 0, 0, 0);
        if (weeklyRem > now) {
          const scheduledDateStr = weeklyRem.toISOString().split('T')[0];
          const vacDateStr = vacDate.toISOString();
          const reminderId = `${babyId}#${vaccine}#weekly#${scheduledDateStr}`;
          remindersToInsert.push({
            PutRequest: {
              Item: {
                reminderId,
                motherId: userId,
                babyId,
                vaccine,
                vaccination_date: vacDateStr,
                scheduled_at: weeklyRem.toISOString(),
                sent: "false",
                type: "weekly"
              }
            }
          });
        }
      }

      // Daily reminder (1 day before)
      const dailyRem = new Date(vacDate);
      dailyRem.setDate(vacDate.getDate() - 1);
      dailyRem.setHours(14, 0, 0, 0);
      if (dailyRem > now) {
        const scheduledDateStr = dailyRem.toISOString().split('T')[0];
        const vacDateStr = vacDate.toISOString();
        const reminderId = `${babyId}#${vaccine}#daily#${scheduledDateStr}`;
        remindersToInsert.push({
          PutRequest: {
            Item: {
              reminderId,
              motherId: userId,
              babyId,
              vaccine,
              vaccination_date: vacDateStr,
              scheduled_at: dailyRem.toISOString(),
              sent: "false",
              type: "daily"
            }
          }
        });
      }
    }

    // 4) Batch write them
    while (remindersToInsert.length) {
      const batch = remindersToInsert.splice(0, 25);
      await ddb.send(new BatchWriteCommand({
        RequestItems: { reminders: batch }
      }));
    }

    return res.json({ message: "Baby DOB and reminders updated" });
  } catch (err) {
    console.error("Birth-date update error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- Add a new baby (and schedule reminders) ---
app.post(
  "/api/baby",
  validate({ body: addBabySchema }),
  authenticateToken,
  async (req, res) => {
    const motherUserId = req.user.userId;
    const { babyName, dateOfBirth, gender } = req.body;

    // 1) Basic validation (schema enforces most)
    if (!babyName || !dateOfBirth || !gender) {
      return res.status(400).json({ error: "All fields required" });
    }

    // 2) Ensure mother exists
    const { Item: mother } = await ddb.send(new GetCommand({
      TableName: "mothers",
      Key: { userId: motherUserId }
    }));
    if (!mother) {
      return res.status(404).json({ error: "Mother profile not found" });
    }

    // 3) Prevent duplicate baby name
    const { Items: existingBabies = [] } = await ddb.send(new QueryCommand({
      TableName: "babies",
      IndexName: "MotherIndex",
      KeyConditionExpression: "motherUserId = :m",
      ExpressionAttributeValues: { ":m": motherUserId }
    }));
    if (existingBabies.some(b => b.babyName.toLowerCase() === babyName.toLowerCase())) {
      return res.status(409).json({ error: "You already have a baby with that name" });
    }

    // 4) Create the baby record
    const babyId = uuidv4();
    const isoDOB = new Date(dateOfBirth + "T00:00:00Z").toISOString();
    await ddb.send(new PutCommand({
      TableName: "babies",
      Item: {
        babyId,
        babyName,
        motherUserId,
        motherEmail: mother.email,
        dateOfBirth: isoDOB,
        gender
      }
    }));

    // 5) Build reminders
    const now = new Date();
    const toWrite = [];
    const { Items: schedule = [] } = await ddb.send(new ScanCommand({
      TableName: "vaccination_schedule"
    }));

    for (let { age, vaccine } of schedule) {
      const offset = parseAgeToDays(age);
      const vaccDate = new Date(isoDOB);
      vaccDate.setDate(vaccDate.getDate() + offset);

      if (vaccDate <= now) {
        continue;
      }

      const msPerDay = 1000 * 60 * 60 * 24;
      const diffDays = (vaccDate.getTime() - now.getTime()) / msPerDay;

      // Weekly reminder
      if (diffDays >= 7) {
        const weeklyRem = new Date(vaccDate);
        weeklyRem.setDate(vaccDate.getDate() - 7);
        weeklyRem.setHours(11, 0, 0, 0);
        if (weeklyRem > now) {
          toWrite.push({
            PutRequest: {
              Item: {
                reminderId: uuidv4(),
                motherId: motherUserId,
                babyId,
                vaccine,
                vaccination_date: vaccDate.toISOString(),
                scheduled_at: weeklyRem.toISOString(),
                sent: "false",
                type: "weekly"
              }
            }
          });
        }
      }

      // Daily reminder
      const dailyRem = new Date(vaccDate);
      dailyRem.setDate(vaccDate.getDate() - 1);
      dailyRem.setHours(11, 0, 0, 0);
      if (dailyRem > now) {
        toWrite.push({
          PutRequest: {
            Item: {
              reminderId: uuidv4(),
              motherId: motherUserId,
              babyId,
              vaccine,
              vaccination_date: vaccDate.toISOString(),
              scheduled_at: dailyRem.toISOString(),
              sent: "false",
              type: "daily"
            }
          }
        });
      }
    }

    // 6) Batch-write reminders in chunks of 25
    while (toWrite.length) {
      const chunk = toWrite.splice(0, 25);
      await ddb.send(new BatchWriteCommand({
        RequestItems: { reminders: chunk }
      }));
    }

    // 7) Respond
    res.status(201).json({
      message: "Baby added & reminders scheduled successfully",
      baby: { babyId, babyName, dateOfBirth, gender }
    });
  }
);

// --- Initialize administered list for a baby ---
app.post(
  "/api/baby/:babyId/administered/init",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const babyId = req.params.babyId;

      // 1) Fetch baby to verify ownership and DOB
      const { Item: baby } = await ddb.send(
        new GetCommand({
          TableName: "babies",
          Key: { babyId },
          ProjectionExpression: "motherUserId, dateOfBirth",
        })
      );
      if (!baby) {
        return res.status(404).json({ error: "Baby not found" });
      }
      if (baby.motherUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // 2) Ensure `administered` exists if not
      await ddb.send(
        new UpdateCommand({
          TableName: "babies",
          Key: { babyId },
          UpdateExpression: "SET administered = if_not_exists(administered, :empty_list)",
          ExpressionAttributeValues: { ":empty_list": [] },
        })
      );

      // 3) Compute past vaccines
      const dob = new Date(baby.dateOfBirth);
      const now = new Date();
      const { Items: scheduleItems = [] } = await ddb.send(
        new ScanCommand({ TableName: "vaccination_schedule" })
      );
      const itemsToAdd = [];
      for (let { age, vaccine } of scheduleItems) {
        const daysOffset = parseAgeToDays(age);
        const vaccDate = new Date(dob);
        vaccDate.setDate(dob.getDate() + daysOffset);
        if (vaccDate < now) {
          itemsToAdd.push({
            vaccine,
            date: vaccDate.toISOString().split("T")[0],
          });
        }
      }

      // 4) Append past vaccines if any
      if (itemsToAdd.length > 0) {
        await ddb.send(
          new UpdateCommand({
            TableName: "babies",
            Key: { babyId },
            UpdateExpression:
              "SET administered = list_append(if_not_exists(administered, :empty_list), :pastVaccines)",
            ExpressionAttributeValues: {
              ":empty_list": [],
              ":pastVaccines": itemsToAdd,
            },
          })
        );
      }

      return res.status(200).json({ message: "Administered list initialized" });
    } catch (err) {
      console.error("Error in POST /api/baby/:babyId/administered/init:", err);
      return res.status(500).json({ error: "Server error while initializing administered list" });
    }
  }
);

// --- Mark a vaccine as administered (idempotent) ---
app.post(
  "/api/baby/:babyId/administered/mark",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const babyId = req.params.babyId;
      const { vaccine, date, type = "manual" } = req.body;

      if (!vaccine || !date) {
        return res.status(400).json({ error: "Missing 'vaccine' or 'date' in request body" });
      }

      // 1) Fetch current administered list
      const getRes = await ddb.send(
        new GetCommand({
          TableName: "babies",
          Key: { babyId },
          ProjectionExpression: "administered, motherUserId",
        })
      );
      if (!getRes.Item) {
        return res.status(404).json({ error: "Baby not found" });
      }

      // 2) Check ownership
      if (getRes.Item.motherUserId !== userId) {
        return res.status(403).json({ error: "Not authorized to modify this baby" });
      }

      // 3) Extract existing list
      const existingList = Array.isArray(getRes.Item.administered)
        ? getRes.Item.administered
        : [];

      // 4) Check if already marked
      const alreadyExists = existingList.some(entry => entry.vaccine === vaccine && entry.date === date);
      if (alreadyExists) {
        return res.status(200).json({ message: "Already marked as administered" });
      }

      // 5) Build new entry
      const newEntry = {
        id: uuidv4(),
        vaccine,
        date,
        markedAt: new Date().toISOString(),
        type,
      };

      // 6) Append atomically
      await ddb.send(
        new UpdateCommand({
          TableName: "babies",
          Key: { babyId },
          UpdateExpression: "SET administered = list_append(if_not_exists(administered, :empty), :newEntry)",
          ExpressionAttributeValues: {
            ":empty": [],
            ":newEntry": [newEntry],
          },
        })
      );

      return res.status(201).json({ message: "Marked administered successfully" });
    } catch (err) {
      console.error("Error in /api/baby/:babyId/administered/mark:", err);
      return res.status(500).json({ error: "Server error while marking administered" });
    }
  }
);

// --- Get administered list for a baby ---
app.get(
  "/api/baby/:babyId/administered",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const babyId = req.params.babyId;

      const getRes = await ddb.send(
        new GetCommand({
          TableName: "babies",
          Key: { babyId },
          ProjectionExpression: "administered, motherUserId",
        })
      );
      if (!getRes.Item) {
        return res.status(404).json({ error: "Baby not found" });
      }
      if (getRes.Item.motherUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const administeredList = Array.isArray(getRes.Item.administered)
        ? getRes.Item.administered
        : [];
      return res.json({ administered: administeredList });
    } catch (err) {
      console.error("Error in GET /api/baby/:babyId/administered:", err);
      return res.status(500).json({ error: "Server error while fetching administered list" });
    }
  }
);

// --- Reminders endpoints (generate & fetch) ---

// POST: regenerate all reminders for a baby
app.post(
  "/api/reminder/:babyId",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const babyId = req.params.babyId;

      // 1) Fetch baby & verify ownership
      const { Item: baby } = await ddb.send(new GetCommand({
        TableName: "babies",
        Key: { babyId },
      }));
      if (!baby) {
        return res.status(404).json({ error: "Baby not found" });
      }
      if (baby.motherUserId !== userId) {
        return res.status(403).json({ error: "Not authorized for this baby" });
      }

      const dob = new Date(baby.dateOfBirth);
      const now = new Date();

      // 2) Delete any existing UNSENT reminders for this baby
      const nowISO = new Date().toISOString();
      const { Items: existing = [] } = await ddb.send(new QueryCommand({
        TableName: "reminders",
        IndexName: "ByBaby", // GSI on (babyId, sent)
        KeyConditionExpression: "babyId = :b AND sent = :false",
        FilterExpression: "scheduled_at > :now", // 🔁 Only delete future reminders
        ExpressionAttributeValues: {
          ":b": babyId,
          ":false": "false",
          ":now": nowISO,
        },
      }));
      const deletes = existing.map((r) => ({
        DeleteRequest: { Key: { reminderId: r.reminderId } },
      }));
      if (deletes.length) {
        while (deletes.length) {
          const chunk = deletes.splice(0, 25);
          await ddb.send(new BatchWriteCommand({
            RequestItems: { reminders: chunk },
          }));
        }
      }

      // 3) Build new reminders with deterministic keys
      const remindersToInsert = [];
      const { Items: schedule = [] } = await ddb.send(new ScanCommand({
        TableName: "vaccination_schedule"
      }));
      for (let { age, vaccine } of schedule) {
        // Compute vaccination date
        const daysOffset = parseAgeToDays(age);
        const vaccDate = new Date(dob);
        vaccDate.setDate(dob.getDate() + daysOffset);
        if (vaccDate <= now) {
          continue;
        }

        // Compute diffDays
        const msPerDay = 1000 * 60 * 60 * 24;
        const diffDays = (vaccDate.getTime() - now.getTime()) / msPerDay;

        // Weekly reminder
        if (diffDays >= 7) {
          const weeklyRem = new Date(vaccDate);
          weeklyRem.setDate(vaccDate.getDate() - 7);
          weeklyRem.setHours(11, 0, 0, 0);
          if (weeklyRem > now) {
            const scheduledDateStr = weeklyRem.toISOString().split("T")[0];
            const vacDateStr = vaccDate.toISOString();
            const reminderId = `${babyId}#${vaccine}#weekly#${scheduledDateStr}`;
            remindersToInsert.push({
              PutRequest: {
                Item: {
                  reminderId,
                  motherId: userId,
                  babyId,
                  vaccine,
                  vaccination_date: vacDateStr,
                  scheduled_at: weeklyRem.toISOString(),
                  sent: "false",
                  type: "weekly",
                },
              },
            });
          }
        }

        // Daily reminder
        const dailyRem = new Date(vaccDate);
        dailyRem.setDate(vaccDate.getDate() - 1);
        dailyRem.setHours(11, 0, 0, 0);
        if (dailyRem > now) {
          const scheduledDateStr = dailyRem.toISOString().split("T")[0];
          const vacDateStr = vaccDate.toISOString();
          const reminderId = `${babyId}#${vaccine}#daily#${scheduledDateStr}`;
          remindersToInsert.push({
            PutRequest: {
              Item: {
                reminderId,
                motherId: userId,
                babyId,
                vaccine,
                vaccination_date: vacDateStr,
                scheduled_at: dailyRem.toISOString(),
                sent: "false",
                type: "daily",
              },
            },
          });
        }
      }

      // 4) Batch write new reminders
      while (remindersToInsert.length) {
        const batch = remindersToInsert.splice(0, 25);
        await ddb.send(new BatchWriteCommand({
          RequestItems: { reminders: batch },
        }));
      }

      return res.status(201).json({ message: "Reminders generated successfully" });
    } catch (err) {
      console.error("Reminder error:", err);
      return res.status(500).json({ error: "Server error while creating reminders" });
    }
  }
);

// GET: fetch existing reminders for a baby
app.get('/api/reminder/:babyId', authenticateToken, async (req, res) => {
  try {
    const { babyId } = req.params;

    // Query the ByBaby GSI for all reminders (sent or not)
    const { Items } = await ddb.send(new QueryCommand({
      TableName: 'reminders',
      IndexName: 'ByBaby',
      KeyConditionExpression: 'babyId = :b',
      ExpressionAttributeValues: { ':b': babyId },
      ProjectionExpression: [
        'reminderId',
        'babyId',
        'vaccine',
        'vaccination_date',
        'scheduled_at',
        'sent',
        'motherId',
        '#tp'
      ].join(', '),
      ExpressionAttributeNames: {
        '#tp': 'type'
      }
    }));

    return res.json(Items);
  } catch (err) {
    console.error('Fetch reminders error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Vaccination Schedule Routes
app.get('/api/vaccination-schedule', async (_req, res) => {
  try {
    const { Items: schedules = [] } = await ddb.send(new ScanCommand({
      TableName: 'vaccination_schedule'
    }));
    schedules.sort((a, b) => a.id - b.id);
    return res.json(schedules);
  } catch (error) {
    console.error('Schedule error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/vaccination-schedule/:age', async (req, res) => {
  try {
    const ageParam = req.params.age;

    // Query via the new GSI "AgeIndex"
    const { Items: schedules = [] } = await ddb.send(new QueryCommand({
      TableName: 'vaccination_schedule',
      IndexName: 'AgeIndex',
      KeyConditionExpression: 'age = :a',
      ExpressionAttributeValues: { ':a': ageParam },
    }));

    return res.json(schedules);
  } catch (error) {
    console.error('Schedule error (by age):', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --- JSON‐Schema Validation Error Handler ---
app.use((err, _req, res, next) => {
  if (err instanceof ValidationError) {
    const messages = err.validationErrors.body.map(e => {
      // e.instancePath is like "/babyName" or "" if missingProperty
      const field = e.instancePath.replace(/^\//, '') || e.params.missingProperty;
      return `${field} ${e.message}`;
    });
    return res.status(400).json({ error: messages.join('; ') });
  }
  next(err);
});

// Lambda handler (via serverless-http)
export const handler = serverless(app);

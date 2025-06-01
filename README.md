# Chanjo Backend - Vaccination Reminder System

Chanjo is a vaccination reminder system designed to help parents track and manage their children's vaccination schedules. This backend service provides the core functionality for user authentication, profile management, baby tracking, vaccination scheduling, and automated reminder emails.

## Table of Contents
- [Features](#features)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [API Documentation](#api-documentation)
- [Cron Jobs](#cron-jobs)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)

## Features

- **User Authentication**: Secure signup/login with JWT tokens
- **Profile Management**: Store mother and baby information
- **Vaccination Scheduling**: Automatic reminder generation based on baby's birth date
- **Email Reminders**: Daily and weekly vaccination notifications
- **Administered Vaccines Tracking**: Record and manage vaccination history
- **Vaccination Schedule API**: Access to standard vaccination timelines

## Project Structure

```
.
├── api/                      # Express API implementation
│   ├── db.js                 # DynamoDB connection
│   ├── server.js             # Main Express server
│   └── schemas/              # JSON validation schemas
│       └── profile.schema.js
├── cron/                     # Scheduled reminder processors
│   ├── daily.js              # Daily reminder handler
│   └── weekly.js             # Weekly reminder handler
├── template.yml              # AWS SAM configuration
```

## Architecture

![System Architecture](https://via.placeholder.com/600x400?text=System+Architecture+Diagram) *Placeholder for architecture diagram*

The system uses:
- **AWS Lambda** for serverless compute
- **API Gateway** for HTTP endpoints
- **DynamoDB** for data storage
- **CloudWatch Events** for cron scheduling
- **SES** for email notifications

## Getting Started

### Prerequisites
- AWS account with appropriate permissions
- AWS SAM CLI installed
- Node.js v20.x
- Configured DynamoDB tables:
  - `mothers`
  - `babies`
  - `reminders`
  - `vaccination_schedule`

### Installation
```bash
# Install dependencies for API
cd api
npm install

# Install dependencies for cron jobs
cd ../cron
npm install

# Return to project root
cd ..
```

## API Documentation

### Authentication
| Endpoint          | Method | Description                       |
|-------------------|--------|-----------------------------------|
| `/api/signup`     | POST   | Register a new mother             |
| `/api/login`      | POST   | Authenticate a user               |
| `/api/reset-password` | POST | Reset user password            |

### Profile Management
| Endpoint          | Method | Description                       |
|-------------------|--------|-----------------------------------|
| `/api/profile`    | POST   | Update mother profile and add baby |
| `/api/profile`    | GET    | Get mother profile and babies     |

### Baby Management
| Endpoint                          | Method | Description                         |
|-----------------------------------|--------|-------------------------------------|
| `/api/baby`                       | POST   | Add a new baby                      |
| `/api/baby/:id/birth-date`        | PUT    | Update baby's birth date            |
| `/api/baby/:babyId/administered`  | GET    | Get administered vaccines           |
| `/api/baby/:babyId/administered/init` | POST | Initialize administered list     |
| `/api/baby/:babyId/administered/mark` | POST | Mark vaccine as administered    |

### Reminders
| Endpoint                | Method | Description                     |
|-------------------------|--------|---------------------------------|
| `/api/reminder/:babyId` | POST   | Regenerate reminders for a baby |
| `/api/reminder/:babyId` | GET    | Get baby's reminders            |

### Vaccination Schedule
| Endpoint                          | Method | Description                     |
|-----------------------------------|--------|---------------------------------|
| `/api/vaccination-schedule`       | GET    | Get full vaccination schedule   |
| `/api/vaccination-schedule/:age`  | GET    | Get schedule by age group       |

## Cron Jobs

The system includes two scheduled jobs:

1. **Daily Reminders** (Runs at 1400hrs EAT daily)
   - Sends reminders for vaccinations due the next day
   - Located in `cron/daily.js`

2. **Weekly Reminders** (Runs every Monday at 1400hrs EAT)
   - Sends reminders for vaccinations due in the next week
   - Located in `cron/weekly.js`

## Environment Variables

The following environment variables must be configured:

| Variable          | Description                           | Example Value                     |
|-------------------|---------------------------------------|-----------------------------------|
| JWT_SECRET        | Secret for JWT tokens                 | `your_secret_key_`                |
| JWT_EXPIRES_IN    | JWT token expiration time             | `24h`                             |
| EMAIL_USER        | Email sender address                  | `youremail@example.com`           |
| EMAIL_PASS        | Email service password                | `your app pass key`               |
| ALLOWED_ORIGIN    | Allowed CORS origin                   | `https://your-frontend-domain.com`|

## Deployment

### How SAM, CloudFormation & S3 Work Together

1. **SAM \(Serverless Application Model\)**

   * Write a high‑level `template.yml` using `AWS::Serverless::*` resources.
   * `sam build` packages each Lambda folder (`api/`, `cron/`) into a ZIP and transforms the SAM syntax into a standard CloudFormation template, placing everything in `.aws-sam/build/`.

2. **S3**

   * SAM uploads those ZIP files to the S3 bucket you configure.
   * Your generated CloudFormation template then refers to those code bundles by their S3 URIs.

3. **CloudFormation**

   * SAM hands off the packaged template, complete with pointers to the S3‐hosted ZIPs—to CloudFormation.
   * CloudFormation provisions all resources in the correct order:\n
     * API Gateway
     * Lambda functions
     * EventBridge rules
     * IAM roles
   * If anything fails, CloudFormation can roll back the entire change set automatically.

### 1. Build the application
```bash
sam build
```

### 2. Deploy to AWS
```bash
sam deploy --guided
```

Follow the prompts to configure:
- Stack name
- AWS region
- Parameter overrides
- IAM capabilities

### 3. After deployment
The API endpoint will be displayed in the outputs. Use this as the base URL for all API requests routed from AWS Amplify.
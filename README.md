# Track Your GitLab Merge Requests with Pulumi + Lambda

### ⏰ Thursday Lunch Build | GitLab → DynamoDB, the DevOps Way

By the end of this workshop, you'll have a serverless system that:

* 💻 Pulls your GitLab merge requests
* 📂 Saves them in DynamoDB
* ⏰ Runs on a schedule
* 💬 Logs everything for observability

---

## ✨ What You'll Use

Here's the tech stack powering your GitLab-to-DynamoDB pipeline:

* GitLab (Personal Access Token)
* AWS Lambda
* DynamoDB (w/ TTL)
* EventBridge (scheduled cron)
* Pulumi (Infra-as-Code)
* TypeScript (or another language!)

---

## ✅ Step-by-Step Overview

| Step | What You Do              | What You See              |
| ---- | ------------------------ | ------------------------- |
| 0    | Create a new Git repo    | ✅ Project initialized     |
| 1    | Get GitLab token + .env  | ✅ Token test success      |
| 2    | Pulumi setup (no deploy) | ✅ Infrastructure code ready |
| 3    | Create Lambda & Deploy   | ✅ CloudWatch logs         |
| 3b   | Inspect AWS resources    | ✅ DynamoDB + IAM created  |
| 4    | Save MRs                 | ✅ Items in DynamoDB       |
| 5    | Automate with scheduling | ✅ Lambda runs on schedule |
| 6    | Destroy resources        | ✅ Clean AWS teardown      |

---

## 🆕 Step 0: Create a New Git Repository

Before getting started, create a new repository on either GitHub or GitLab. This will be your project directory for the workshop.

```bash
git init gitlab-metrics
cd gitlab-metrics
git remote add origin <your-repo-url>
```

Create a basic folder structure:

```bash
mkdir .infrastructure lambda
```

Create a `.gitignore` file and paste in the following:

```gitignore
# Environment and config
.env
.pulumi/

# Dependencies
node_modules/
__pycache__/

# Build artifacts
*.zip

# System files
.DS_Store
```

---

## 🔐 Step 1: Get and Test Your GitLab Token

### 1.1 Generate Token and Create .env

* Go to [GitLab > Preferences > Access Tokens](https://gitlab.com/-/profile/personal_access_tokens)
* Name: `gitlab-metrics`
* Scopes: ✅ `read_api`
* Click **Create Token** and **copy it** immediately!
* Create a `.env` file at the root of your project:

```env
GITLAB_TOKEN=your_token_here
GITLAB_USERNAME=your_gitlab_username_here
```

### 1.2 Test It Using .env

First load the environment variables:

```bash
source .env
```

Then run this test request against the `elite-webapp` project (ID `47813856`):

```bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.com/api/v4/projects/48779531/merge_requests?author_username=$GITLAB_USERNAME&state=merged&updated_after=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)" \
  | jq '.[].title'
```

You should get back an array of merge request JSON objects. If not, check your scopes or token value.

### 1.3 Put these values in the parameter store

This can either be done through the AWS console or via these commands.

```bash
aws ssm put-parameter --name "/moondawg/gitlab/token" --value "$GITLAB_TOKEN" --type SecureString
aws ssm put-parameter --name "/moondawg/gitlab/username" --value "$GITLAB_USERNAME" --type String
```

---

## 🧬 Step 2: Setup Pulumi Infrastructure Code

```bash
cd .infrastructure
pulumi new typescript
pulumi config set aws:region us-east-1
npm install @pulumi/aws
```

### `.infrastructure/index.ts`

```ts
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const region = aws.config.region || 'us-east-1';
const tableName = 'moondawg-merge-requests';

// Note: GitLab token and username should be manually created in Parameter Store:
// - /moondawg/gitlab/token (SecureString)
// - /moondawg/gitlab/username (String)

// DynamoDB table
const table = new aws.dynamodb.Table(tableName, {
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'project_id',
  rangeKey: 'iid',
  attributes: [
    { name: 'project_id', type: 'N' },
    { name: 'iid', type: 'N' },
  ],
  ttl: { attributeName: 'ttl', enabled: true },
  tags: { Environment: pulumi.getStack(), Project: 'MoondawgMRTracker' },
});

// IAM policy for Lambda
const policy = new aws.iam.Policy('moondawg-lambda-dynamo-policy', {
  description: 'Allow Lambda to write MRs to DynamoDB and read from Parameter Store',
  policy: pulumi.all([table.name]).apply(([tableName]) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'dynamodb:PutItem', 'dynamodb:UpdateItem',
            'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'
          ],
          Resource: `arn:aws:dynamodb:${region}:*:table/${tableName}`,
        },
        {
          Effect: 'Allow',
          Action: [
            'ssm:GetParameter',
            'ssm:GetParameters'
          ],
          Resource: [
            `arn:aws:ssm:${region}:*:parameter/moondawg/gitlab/token`,
            `arn:aws:ssm:${region}:*:parameter/moondawg/gitlab/username`
          ],
        },
      ],
    })
  )
});

// IAM Role for Lambda
const lambdaRole = new aws.iam.Role('moondawg-lambda-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
});

// Attach policy
new aws.iam.RolePolicyAttachment('moondawg-lambda-policy-attach', {
  role: lambdaRole.name,
  policyArn: policy.arn,
});

// Lambda function (to be zipped from /lambda)
const lambda = new aws.lambda.Function('moondawg-lambda', {
  runtime: 'nodejs18.x',
  code: new pulumi.asset.FileArchive('../lambda/write-lambda.zip'),
  role: lambdaRole.arn,
  handler: 'index.handler',
  environment: {
    variables: {
      GITLAB_TOKEN_PARAM: '/moondawg/gitlab/token',
      USERNAME_PARAM: '/moondawg/gitlab/username',
      DYNAMODB_TABLE_NAME: table.name,
    },
  },
  timeout: 300,
});

// EventBridge trigger
const rule = new aws.cloudwatch.EventRule('moondawg-schedule', {
  scheduleExpression: 'rate(5 minutes)',
});

new aws.cloudwatch.EventTarget('moondawg-target', {
  rule: rule.name,
  arn: lambda.arn,
});

new aws.lambda.Permission('moondawg-permission', {
  action: 'lambda:InvokeFunction',
  function: lambda.name,
  principal: 'events.amazonaws.com',
  sourceArn: rule.arn,
});
```

**Note:** Don't run `pulumi up` yet! We need to create the Lambda ZIP file first.

---

## ✅ Step 3: Create Lambda & Deploy Infrastructure

1. Write your Lambda logic in `/lambda/index.ts`
2. Example minimal script:

```ts
import fetch from 'node-fetch';

export const handler = async () => {
  const res = await fetch('https://gitlab.com/api/v4/projects/48779531/merge_requests?state=merged', {
    headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN! },
  });
  const data = await res.json();
  console.log(`👀 Found ${data.length} MRs`);
  return { statusCode: 200, body: 'Done' };
};
```

3. Zip and deploy:

```bash
cd lambda
zip -r write-lambda.zip .
cd ../.infrastructure
pulumi up --yes
```

✅ View logs in AWS Console > Lambda > Monitor > CloudWatch Logs

---

## 🔍 Step 3b: Inspect Resources in the AWS Console

After running pulumi up, verify that the infrastructure was provisioned correctly:

✅ **DynamoDB Table**

Navigate to AWS Console > DynamoDB > Tables

Look for a table named `moondawg-merge-requests`

Confirm TTL is enabled on the `ttl` attribute

✅ **IAM Policy & Role**

Go to IAM > Policies, search for `moondawg-lambda-dynamo-policy`

Check that it grants PutItem, Query, Scan, etc. to the correct table AND Parameter Store access

Then go to IAM > Roles, search for `moondawg-lambda-role`

Under Permissions, verify that the policy is attached

✅ **Lambda Function**

Head to AWS Console > Lambda > Functions

Find the function named `moondawg-lambda`

Click into the function to see its environment variables and configuration

Verify the environment variables point to Parameter Store paths

✅ **EventBridge Rule**

Visit EventBridge > Rules, search for `moondawg-schedule`

Ensure it's set to run on a 5-minute interval

Check the target is your Lambda function

Everything should now be wired up! Continue to the next step to add DynamoDB logic to your Lambda function.

---

## 📂 Step 4: Save to DynamoDB

Update your handler to write to DynamoDB using AWS SDK v3:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import fetch from 'node-fetch';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const getParameter = async (paramName: string) => {
  const result = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: true
  }));
  return result.Parameter?.Value;
};

export const handler = async () => {
  // Get GitLab credentials from Parameter Store
  const gitlabToken = await getParameter(process.env.GITLAB_TOKEN_PARAM!);
  const username = await getParameter(process.env.USERNAME_PARAM!);

  const res = await fetch('https://gitlab.com/api/v4/projects/48779531/merge_requests?state=merged', {
    headers: { 'PRIVATE-TOKEN': gitlabToken! },
  });
  const mrs = await res.json();

  for (const mr of mrs.slice(0, 5)) {
    await dynamo.send(new PutCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME!,
      Item: {
        project_id: mr.project_id,
        iid: mr.iid,
        title: mr.title,
        ttl: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      }
    }));
  }

  console.log(`✅ Saved ${mrs.length} MRs`);
  return { statusCode: 200, body: 'Saved' };
};
```

Re-zip and redeploy:

```bash
cd lambda
zip -r write-lambda.zip .
cd ../.infrastructure
pulumi up --yes
```

✅ Run another `pulumi up` and check DynamoDB > Explore Table > Scan

---

## ⏰ Step 5: Let It Run Automatically

Already wired! EventBridge runs every 5 minutes (adjust as needed):

```ts
scheduleExpression: 'rate(5 minutes)'
```

✅ Your Lambda now runs automatically.

---

## 🪑 Step 6: Tear It All Down

```bash
pulumi destroy
```

---

## 🚀 Bonus Next Steps

* Add filtering by week or day
* Include project filters
* Generate dashboard or Slack summary
* Export to S3 for long-term history

---

This lunch session is going to be a blast.
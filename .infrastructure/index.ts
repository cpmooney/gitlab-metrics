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
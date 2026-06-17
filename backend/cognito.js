/**
 * cognito.js — AWS Cognito helper
 *
 * Wraps the Cognito Identity Provider SDK so that backend/index.js
 * only needs to call friendly async functions.
 *
 * Required env vars:
 *   COGNITO_USER_POOL_ID  e.g. us-east-1_xxxxxxxxx
 *   COGNITO_CLIENT_ID     App Client ID (no secret, public client)
 *   COGNITO_REGION        e.g. us-east-1
 */

const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminGetUserCommand,
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminUpdateUserAttributesCommand,
} = require('@aws-sdk/client-cognito-identity-provider');


const REGION       = process.env.COGNITO_REGION      || process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID    = process.env.COGNITO_CLIENT_ID;

const clientConfig = { region: REGION };
if (process.env.COGNITO_ACCESS_KEY_ID && process.env.COGNITO_SECRET_ACCESS_KEY) {
  clientConfig.credentials = {
    accessKeyId: process.env.COGNITO_ACCESS_KEY_ID,
    secretAccessKey: process.env.COGNITO_SECRET_ACCESS_KEY,
  };
}

const client = new CognitoIdentityProviderClient(clientConfig);

// ---------------------------------------------------------------------------
// Confirm Registration OTP
// ---------------------------------------------------------------------------
async function confirmSignUp(email, code) {
  if (!CLIENT_ID) throw new Error('COGNITO_CLIENT_ID env var is required');
  const command = new ConfirmSignUpCommand({
    ClientId: CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  });
  return client.send(command);
}

// ---------------------------------------------------------------------------
// Register a new user (email + password + custom attributes)
// Returns: { userSub, userConfirmed, codeDeliveryDetails }
// ---------------------------------------------------------------------------
async function signUp(email, password, attributes = {}) {
  if (!USER_POOL_ID || !CLIENT_ID) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID env vars are required');
  }

  const userAttributes = [
    { Name: 'email', Value: email },
  ];

  // Optional profile attributes stored in Cognito
  if (attributes.name) {
    userAttributes.push({ Name: 'name', Value: attributes.name });
  }
  // Note: custom:organization and custom:role are stored in local SQLite profile,
  // not in the Cognito User Pool (custom attributes not defined in pool schema).

  const command = new SignUpCommand({
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: userAttributes,
  });

  const result = await client.send(command);
  return {
    userSub: result.UserSub,
    userConfirmed: result.UserConfirmed,
    codeDeliveryDetails: result.CodeDeliveryDetails,
  };
}

// ---------------------------------------------------------------------------
// Authenticate with email + password (USER_PASSWORD_AUTH flow)
// Returns: { accessToken, idToken, refreshToken, expiresIn }
// ---------------------------------------------------------------------------
async function initiateAuth(email, password) {
  if (!CLIENT_ID) {
    throw new Error('COGNITO_CLIENT_ID env var is required');
  }

  const command = new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });

  const result = await client.send(command);

  if (!result.AuthenticationResult) {
    // Challenge (e.g. NEW_PASSWORD_REQUIRED, MFA) — surface as error for now
    throw new Error(
      `Authentication challenge: ${result.ChallengeName || 'unknown'}. ` +
      'Please use the AWS Console to resolve the challenge on this account.'
    );
  }

  const auth = result.AuthenticationResult;
  return {
    accessToken:  auth.AccessToken,
    idToken:      auth.IdToken,
    refreshToken: auth.RefreshToken,
    expiresIn:    auth.ExpiresIn,
    tokenType:    auth.TokenType,
  };
}

// ---------------------------------------------------------------------------
// Send a forgot-password reset code to the user's email
// ---------------------------------------------------------------------------
async function forgotPassword(email) {
  if (!CLIENT_ID) throw new Error('COGNITO_CLIENT_ID env var is required');

  const command = new ForgotPasswordCommand({
    ClientId: CLIENT_ID,
    Username: email,
  });

  const result = await client.send(command);
  return { codeDeliveryDetails: result.CodeDeliveryDetails };
}

// ---------------------------------------------------------------------------
// Confirm a forgot-password reset with the code from email
// ---------------------------------------------------------------------------
async function confirmForgotPassword(email, confirmationCode, newPassword) {
  if (!CLIENT_ID) throw new Error('COGNITO_CLIENT_ID env var is required');

  const command = new ConfirmForgotPasswordCommand({
    ClientId: CLIENT_ID,
    Username: email,
    ConfirmationCode: confirmationCode,
    Password: newPassword,
  });

  await client.send(command);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin: add a user to a Cognito group (e.g. "admins")
// ---------------------------------------------------------------------------
async function adminAddToGroup(email, groupName) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');

  const command = new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    GroupName: groupName,
  });

  await client.send(command);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin: remove a user from a Cognito group
// ---------------------------------------------------------------------------
async function adminRemoveFromGroup(email, groupName) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');

  const command = new AdminRemoveUserFromGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    GroupName: groupName,
  });

  await client.send(command);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin: auto-confirm a user (skip email verification) — useful for testing
// ---------------------------------------------------------------------------
async function adminConfirmSignUp(email) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');

  const command = new AdminConfirmSignUpCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
  });

  await client.send(command);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin: get Cognito user details by email/username
// ---------------------------------------------------------------------------
async function adminGetUser(email) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');

  const command = new AdminGetUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
  });

  const result = await client.send(command);
  return result;
}

// ---------------------------------------------------------------------------
// List ALL users in the User Pool (paginated, max 500 returned)
// Returns array of {sub, email, name, status, enabled, createdAt, isAdmin}
// ---------------------------------------------------------------------------
async function listAllUsers(adminEmailSet = new Set()) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');

  // Get the set of admin usernames (emails) in one call
  let adminUsernames = new Set();
  try {
    const groupRes = await client.send(new ListUsersInGroupCommand({
      UserPoolId: USER_POOL_ID,
      GroupName: 'admins',
      Limit: 60,
    }));
    (groupRes.Users || []).forEach(u => {
      const emailAttr = (u.Attributes || []).find(a => a.Name === 'email');
      if (emailAttr) adminUsernames.add(emailAttr.Value.toLowerCase());
    });
  } catch { /* admins group may not exist yet */ }

  // Paginate all users
  const users = [];
  let paginationToken;
  do {
    const res = await client.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
      ...(paginationToken ? { PaginationToken: paginationToken } : {}),
    }));

    for (const u of res.Users || []) {
      const attrs = Object.fromEntries((u.Attributes || []).map(a => [a.Name, a.Value]));
      users.push({
        userId:       attrs.sub,
        cognitoSub:   attrs.sub,
        email:        attrs.email || u.Username,
        name:         attrs.name  || attrs.email || u.Username,
        organization: attrs['custom:organization'] || '',
        role:         attrs['custom:role']         || '',
        status:       u.UserStatus,
        enabled:      u.Enabled,
        createdAt:    u.UserCreateDate?.toISOString(),
        isAdmin:      adminUsernames.has((attrs.email || u.Username).toLowerCase()),
      });
    }
    paginationToken = res.PaginationToken;
  } while (paginationToken);

  return users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------------------------------------------------------------------
// Get a single user's attributes as a flat object
// ---------------------------------------------------------------------------
async function adminGetUserAttributes(email) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');
  const res = await client.send(new AdminGetUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
  }));
  const attrs = Object.fromEntries((res.UserAttributes || []).map(a => [a.Name, a.Value]));
  return {
    userId:       attrs.sub,
    cognitoSub:   attrs.sub,
    email:        attrs.email || email,
    name:         attrs.name  || attrs.email || email,
    organization: attrs['custom:organization'] || '',
    role:         attrs['custom:role']         || '',
    status:       res.UserStatus,
    enabled:      res.Enabled,
  };
}

// ---------------------------------------------------------------------------
// Admin: update user attributes (name / custom attributes)
// ---------------------------------------------------------------------------
async function adminUpdateUserAttributes(email, attributes = {}) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');
  const UserAttributes = [];
  if (attributes.name !== undefined) {
    UserAttributes.push({ Name: 'name', Value: String(attributes.name) });
  }
  if (attributes.organization !== undefined) {
    UserAttributes.push({ Name: 'custom:organization', Value: String(attributes.organization) });
  }
  if (attributes.role !== undefined) {
    UserAttributes.push({ Name: 'custom:role', Value: String(attributes.role) });
  }
  if (UserAttributes.length === 0) return { success: true };
  await client.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    UserAttributes
  }));
  return { success: true };
}

// ---------------------------------------------------------------------------
// Hard-delete a user from Cognito
// ---------------------------------------------------------------------------
async function adminDeleteUser(email) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');
  await client.send(new AdminDeleteUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
  }));
  return { success: true };
}

// ---------------------------------------------------------------------------
// Check which Cognito groups a user belongs to
// -------------------------------------------------------------------
async function adminGetUserGroups(email) {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID env var is required');
  const res = await client.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
  }));
  return (res.Groups || []).map(g => g.GroupName);
}

// Export
module.exports = {
  signUp,
  confirmSignUp,
  initiateAuth,
  forgotPassword,
  confirmForgotPassword,
  adminAddToGroup,
  adminRemoveFromGroup,
  adminConfirmSignUp,
  adminGetUser,
  listAllUsers,
  adminGetUserAttributes,
  adminUpdateUserAttributes,
  adminDeleteUser,
  adminGetUserGroups,
};

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS || 'noreply@example.com'; 

// Initialize the SES client (uses same AWS credentials as Cognito/S3)
let sesClient = null;
function getClient() {
  if (!sesClient) {
    sesClient = new SESClient({ region: REGION });
  }
  return sesClient;
}

/**
 * Sends a generic HTML/Text email using SES.
 */
async function sendRawEmail(toAddress, subject, htmlBody, textBody) {
  // If SES is not fully configured, bypass in dev
  if (!process.env.SES_FROM_ADDRESS && process.env.NODE_ENV !== 'production') {
    console.warn(`[SES DEV BYPASS] Would have sent email to ${toAddress}. Subject: ${subject}`);
    return;
  }

  const client = getClient();
  const params = {
    Destination: {
      ToAddresses: [toAddress]
    },
    Message: {
      Body: {
        Html: { Charset: 'UTF-8', Data: htmlBody },
        Text: { Charset: 'UTF-8', Data: textBody || htmlBody.replace(/<[^>]*>?/gm, '') }
      },
      Subject: { Charset: 'UTF-8', Data: subject }
    },
    Source: SES_FROM_ADDRESS
  };

  try {
    await client.send(new SendEmailCommand(params));
    console.log(`[SES] Successfully sent email to ${toAddress}`);
  } catch (err) {
    console.error(`[SES] Failed to send email to ${toAddress}:`, err);
  }
}

// -------------------------------------------------------------------------
// Specific Email Actions
// -------------------------------------------------------------------------

/**
 * Sent to a user when their UPLOAD REQUEST (sample data) is APPROVED.
 * Prompts them to upload their full dataset.
 */
async function sendUploadApprovedEmail(toEmail, datasetTitle, requestId, appBaseUrl) {
  const subject = `Your Dataset Upload Request is Approved: ${datasetTitle}`;
  const uploadLink = `${appBaseUrl}/upload/full/${requestId}`;
  const html = `
    <h2>Your Upload Request was Approved!</h2>
    <p>Good news! Your sample dataset submission for "<strong>${datasetTitle}</strong>" has been approved by the admin team.</p>
    <p>You can now upload the <strong>Full Dataset</strong> via the link below:</p>
    <p><a href="${uploadLink}" style="padding:10px 15px; background:#2a7c6f; color:white; text-decoration:none; border-radius:4px;">Upload Full Dataset</a></p>
    <p>Or paste this link into your browser: <br/>${uploadLink}</p>
    <br/>
    <p>Once the full dataset is uploaded, it will become publicly available in the platform under your chosen access controls.</p>
  `;
  await sendRawEmail(toEmail, subject, html);
}

/**
 * Sent to a user when their UPLOAD REQUEST is REJECTED.
 */
async function sendUploadRejectedEmail(toEmail, datasetTitle, reason, adminNotes) {
  const subject = `Update on your Upload Request: ${datasetTitle}`;
  const html = `
    <h2>Upload Request Status Update</h2>
    <p>Your sample dataset submission for "<strong>${datasetTitle}</strong>" could not be approved at this time.</p>
    <p><strong>Reason:</strong> ${reason}</p>
    ${adminNotes ? `<p><strong>Admin Notes:</strong> ${adminNotes}</p>` : ''}
    <p>If you believe this is an error or wish to update your submission, please contact us or submit a new request.</p>
  `;
  await sendRawEmail(toEmail, subject, html);
}

/**
 * Sent to a user when their DOWNLOAD REQUEST is APPROVED.
 */
async function sendDownloadApprovedEmail(toEmail, datasetTitle, datasetId, appBaseUrl) {
  const subject = `Your Download Request is Approved: ${datasetTitle}`;
  const viewLink = `${appBaseUrl}/dataset/${datasetId}`;
  const html = `
    <h2>Your Download Request was Approved!</h2>
    <p>Good news! Your request to download the full dataset for "<strong>${datasetTitle}</strong>" has been approved.</p>
    <p>You can now download the full dataset by visiting the dataset's page while logged in:</p>
    <p><a href="${viewLink}" style="padding:10px 15px; background:#2a7c6f; color:white; text-decoration:none; border-radius:4px;">View Dataset</a></p>
    <p>Or paste this link into your browser: <br/>${viewLink}</p>
  `;
  await sendRawEmail(toEmail, subject, html);
}

/**
 * Sent to a user when their DOWNLOAD REQUEST is REJECTED.
 */
async function sendDownloadRejectedEmail(toEmail, datasetTitle, reason, adminNotes) {
  const subject = `Update on your Download Request: ${datasetTitle}`;
  const html = `
    <h2>Download Request Status Update</h2>
    <p>Your request to download "<strong>${datasetTitle}</strong>" could not be approved at this time.</p>
    <p><strong>Reason:</strong> ${reason}</p>
    ${adminNotes ? `<p><strong>Admin Notes:</strong> ${adminNotes}</p>` : ''}
    <p>If you have any questions, please reach out to the dataset administrators.</p>
  `;
  await sendRawEmail(toEmail, subject, html);
}

/**
 * Sent for "Clarify / Comment" actions by the admin.
 */
async function sendClarificationEmail(toEmail, requestType, title, adminNotes, requestId, appBaseUrl) {
  const subject = `Action Required: Clarification needed for your ${requestType} request`;
  const html = `
    <h2>Clarification Needed</h2>
    <p>An administrator has reviewed your ${requestType} request for "<strong>${title}</strong>" and requires additional information or updates.</p>
    <p><strong>Admin Comment:</strong><br/>
    <em>${adminNotes}</em></p>
    <p>Please reply to this communication or update your request accordingly.</p>
  `;
  await sendRawEmail(toEmail, subject, html);
}

module.exports = {
  sendUploadApprovedEmail,
  sendUploadRejectedEmail,
  sendDownloadApprovedEmail,
  sendDownloadRejectedEmail,
  sendClarificationEmail
};

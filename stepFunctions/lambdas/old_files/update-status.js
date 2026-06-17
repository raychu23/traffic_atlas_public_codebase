/**
 * dataset-update-status
 * Updates database record with processing status at each step
 */
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  console.log('UpdateStatus event:', JSON.stringify(event, null, 2));
  
  const { dataset_id, status, summary_path, error_message } = event;
  const timestamp = new Date().toISOString();
  
  try {
    const updateParams = {
      TableName: 'dataset-uploads',
      Key: { dataset_id },
      UpdateExpression: 'SET processing_status = :status, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': status,
        ':timestamp': timestamp
      }
    };
    
    // Add optional fields based on status
    if (status === 'completed' && summary_path) {
      updateParams.UpdateExpression += ', summary_s3_path = :summary_path';
      updateParams.ExpressionAttributeValues[':summary_path'] = summary_path;
    }
    
    if (error_message) {
      updateParams.UpdateExpression += ', error_message = :error, last_error_at = :timestamp';
      updateParams.ExpressionAttributeValues[':error'] = error_message;
    }
    
    await dynamodb.update(updateParams).promise();
    
    console.log(`Updated dataset ${dataset_id} status to ${status}`);
    
    return {
      success: true,
      dataset_id,
      status,
      updated_at: timestamp
    };
    
  } catch (error) {
    console.error('UpdateStatus error:', error);
    throw error;
  }
};

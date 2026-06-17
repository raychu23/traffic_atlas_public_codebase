/**
 * dataset-register-upload
 * Creates initial database record and manifest when zip is uploaded
 */
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log('RegisterUpload event:', JSON.stringify(event, null, 2));
  
  const { dataset_id, user_id, bucket, zip_key } = event;
  const timestamp = new Date().toISOString();
  
  try {
    // 1. Create DB record
    const dbParams = {
      TableName: 'dataset-uploads',
      Item: {
        dataset_id,
        user_id,
        upload_status: 'uploaded',
        processing_status: 'pending',
        zip_s3_path: `s3://${bucket}/${zip_key}`,
        created_at: timestamp,
        updated_at: timestamp,
        summary_s3_path: null
      }
    };
    
    await dynamodb.put(dbParams).promise();
    console.log('DB record created for dataset:', dataset_id);
    
    // 2. Create upload manifest in S3
    const manifestKey = `sample_data/${dataset_id}/sample_analysis/manifest/upload_manifest.json`;
    const manifest = {
      dataset_id,
      user_id,
      zip_source: `s3://${bucket}/${zip_key}`,
      uploaded_at: timestamp,
      processing_started_at: null,
      processing_completed_at: null,
      status: 'awaiting_extraction'
    };
    
    const s3PutParams = {
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
      Metadata: {
        'dataset-id': dataset_id,
        'user-id': user_id
      }
    };
    
    await s3.putObject(s3PutParams).promise();
    console.log('Manifest created at:', manifestKey);
    
    return {
      success: true,
      dataset_id,
      manifest_path: `s3://${bucket}/${manifestKey}`,
      db_record_created: true
    };
    
  } catch (error) {
    console.error('RegisterUpload error:', error);
    throw error;
  }
};

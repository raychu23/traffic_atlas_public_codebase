const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const prefixRaw = process.env.S3_PREFIX || '';
const prefix = prefixRaw.replace(/^\/+|\/+$/g, '');

if (!bucket) {
  console.error('Missing S3_BUCKET');
  process.exit(1);
}

const client = new S3Client({ region });

function keyFor(relativePath) {
  return prefix ? `${prefix}/${relativePath}` : relativePath;
}

async function putText(relativePath, contentType, body = '') {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(relativePath),
      Body: body,
      ContentType: contentType
    })
  );
}

async function main() {
  const folderMarkers = [
    'users/',
    'datasets/',
    'staging/uploads/',
    'admin/queues/',
    'reviews/upload_requests/',
    'reviews/download_requests/',
    'audit/uploads/',
    'audit/downloads/'
  ];

  for (const marker of folderMarkers) {
    await putText(marker, 'application/x-directory', '');
  }

  await putText('admin/queues/upload_requests_index.json', 'application/json', '[]\n');
  await putText('admin/queues/download_requests_index.json', 'application/json', '[]\n');

  console.log(
    JSON.stringify(
      {
        success: true,
        bucket,
        prefix,
        created: [...folderMarkers, 'admin/queues/upload_requests_index.json', 'admin/queues/download_requests_index.json']
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

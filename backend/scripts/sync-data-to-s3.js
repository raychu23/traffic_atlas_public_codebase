const fs = require('fs').promises;
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET;
const PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');

function guessContentType(filePath) {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.txt')) return 'text/plain';
  if (filePath.endsWith('.zip')) return 'application/zip';
  if (filePath.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

async function listFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(fullPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function toKey(filePath) {
  const relative = path.relative(DATA_ROOT, filePath).replace(/\\/g, '/');
  return PREFIX ? `${PREFIX}/${relative}` : relative;
}

async function main() {
  if (!BUCKET) {
    throw new Error('Missing S3_BUCKET environment variable');
  }

  const client = new S3Client({ region: REGION });
  const files = await listFilesRecursively(DATA_ROOT);

  console.log(`Found ${files.length} files under ${DATA_ROOT}`);

  let uploaded = 0;
  for (const filePath of files) {
    const key = toKey(filePath);
    const body = await fs.readFile(filePath);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: guessContentType(filePath)
    }));
    uploaded += 1;
    if (uploaded % 25 === 0 || uploaded === files.length) {
      console.log(`Uploaded ${uploaded}/${files.length}`);
    }
  }

  console.log(`S3 sync complete. Bucket=${BUCKET} Prefix=${PREFIX || '(root)'}`);
}

main().catch((error) => {
  console.error(`S3 sync failed: ${error.message}`);
  process.exit(1);
});

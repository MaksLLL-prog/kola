// Хранилище картинок: локальная папка по умолчанию, S3-совместимое (AWS, R2, MinIO, Selectel…) если задан S3_BUCKET.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const UPLOADS = path.join(DATA_DIR, 'uploads');
const BUCKET = process.env.S3_BUCKET || '';
const PUBLIC = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

let s3, sdk;
function client() {
  if (!s3) {
    sdk = require('@aws-sdk/client-s3');
    s3 = new sdk.S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
    });
  }
  return s3;
}

async function save(buf, ext) {
  const name = crypto.randomBytes(12).toString('hex') + ext;
  if (BUCKET) {
    if (!PUBLIC) throw new Error('Для S3 задайте S3_PUBLIC_URL — публичный адрес бакета');
    await client().send(new sdk.PutObjectCommand({
      Bucket: BUCKET, Key: 'uploads/' + name, Body: buf, ContentType: MIME[ext],
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return PUBLIC + '/uploads/' + name;
  }
  await fs.promises.writeFile(path.join(UPLOADS, name), buf);
  return '/uploads/' + name;
}

async function remove(url) {
  if (!url) return;
  try {
    if (BUCKET && PUBLIC && url.startsWith(PUBLIC + '/'))
      await client().send(new sdk.DeleteObjectCommand({ Bucket: BUCKET, Key: 'uploads/' + path.basename(url) }));
    else if (url.startsWith('/uploads/')) await fs.promises.unlink(path.join(UPLOADS, path.basename(url)));
  } catch { /* файл уже удалён — не страшно */ }
}

module.exports = { save, remove, UPLOADS, publicOrigin: PUBLIC ? new URL(PUBLIC).origin : '' };

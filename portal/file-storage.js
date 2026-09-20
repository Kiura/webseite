'use strict';
const {createHash, randomUUID} = require('node:crypto');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), {code});

function storageConfig(env = process.env) {
  const backend = env.PORTAL_FILE_STORAGE || 'database';
  if (!['database', 's3'].includes(backend)) throw failure('FILE_STORAGE_CONFIGURATION');
  const mb = Number(env.PORTAL_STORAGE_MB || 2048);
  if (!Number.isSafeInteger(mb) || mb < 1 || mb > 10485760) throw failure('FILE_STORAGE_LIMIT');
  return {backend, limit: mb * 1024 * 1024};
}

// Only the server receives credentials. No public buckets, object URLs or
// presigned links are exposed by this adapter; portal authorization still applies.
function createFileStorage(env = process.env, options = {}) {
  const {backend} = storageConfig(env);
  const keys = ['PORTAL_S3_BUCKET', 'PORTAL_S3_REGION', 'PORTAL_S3_ACCOUNT_ID', 'PORTAL_S3_ACCESS_KEY_ID', 'PORTAL_S3_SECRET_ACCESS_KEY'];
  const configured = keys.every(key => !!env[key]);
  if (!configured) {
    if (backend === 's3') throw failure('FILE_STORAGE_CONFIGURATION');
    // Database backend stays usable: an incomplete S3 setup must not take the whole portal (including login) offline.
    if (keys.some(key => !!env[key]) && env.NODE_ENV !== 'test') console.warn('S3 configuration incomplete (' + keys.filter(key => !env[key]).join(', ') + ' missing); originals stay in the database until all values are set.');
    return null;
  }
  const bucket = env.PORTAL_S3_BUCKET, region = env.PORTAL_S3_REGION, account = env.PORTAL_S3_ACCOUNT_ID;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || region !== 'eu-central-1' || !/^\d{12}$/.test(account)) throw failure('FILE_STORAGE_CONFIGURATION');
  const {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand} = require('@aws-sdk/client-s3');
  const client = options.client || new S3Client({
    region, maxAttempts: 2,
    credentials: {accessKeyId: env.PORTAL_S3_ACCESS_KEY_ID, secretAccessKey: env.PORTAL_S3_SECRET_ACCESS_KEY},
    // Ignore ambient endpoint overrides; original files go only to AWS Frankfurt.
    endpoint: `https://s3.${region}.amazonaws.com`, forcePathStyle: false,
  });
  const base = {Bucket: bucket, ExpectedBucketOwner: account};
  async function send(command) {
    try {return await client.send(command, {abortSignal: AbortSignal.timeout(45000)});}
    catch {throw failure('FILE_STORAGE_UNAVAILABLE');}
  }
  function validate(ref) {
    if (ref.backend !== 's3' || ref.bucket !== bucket || ref.region !== region || ref.account !== account ||
        !/^originals\/[a-f0-9-]{36}$/.test(ref.key) || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > MAX_FILE_BYTES) throw failure('FILE_STORAGE_REFERENCE');
  }
  return {
    backend, region,
    async write(bytes, onAttempt = () => {}) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw failure('FILE_STORAGE_SIZE');
      const ref = {backend:'s3', bucket, region, account, key:'originals/' + randomUUID(), size:bytes.length, sha256:digest(bytes)};
      // Register cleanup before sending: a timed-out PUT may still have succeeded.
      await onAttempt(ref);
      await send(new PutObjectCommand({...base, Key:ref.key, Body:bytes, ContentLength:bytes.length,
        ContentType:'application/octet-stream', ServerSideEncryption:'AES256',
        ChecksumSHA256:Buffer.from(ref.sha256, 'hex').toString('base64'),
        Metadata:{sha256:ref.sha256}, IfNoneMatch:'*'}));
      return ref;
    },
    async read(ref) {
      validate(ref);
      const response = await send(new GetObjectCommand({...base, Key:ref.key, ChecksumMode:'ENABLED'}));
      try {
        if (response.ContentLength !== ref.size) throw failure('FILE_STORAGE_INTEGRITY');
        const parts = []; let size = 0;
        for await (const part of response.Body) {
          size += part.length;
          if (size > ref.size) throw failure('FILE_STORAGE_INTEGRITY');
          parts.push(Buffer.from(part));
        }
        const bytes = Buffer.concat(parts);
        if (bytes.length !== ref.size || digest(bytes) !== ref.sha256) throw failure('FILE_STORAGE_INTEGRITY');
        return bytes;
      } catch (error) {
        response.Body?.destroy?.();
        throw failure(error.code === 'FILE_STORAGE_INTEGRITY' ? error.code : 'FILE_STORAGE_UNAVAILABLE');
      }
    },
    async remove(ref) {validate(ref); await send(new DeleteObjectCommand({...base, Key:ref.key}));},
    close() {client.destroy?.();},
  };
}

module.exports = {createFileStorage, storageConfig, MAX_FILE_BYTES};

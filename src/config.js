'use strict';

const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Build runtime configuration. Tests can pass exact paths through overrides.
 */
function loadConfig(env = process.env, overrides = {}) {
  const isProduction = env.NODE_ENV === 'production';
  const root = overrides.root || PROJECT_ROOT;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(root, 'data');
  const uploadDir = overrides.uploadDir || env.UPLOAD_DIR || path.join(root, 'uploads');
  const s3Fields = [env.S3_ENDPOINT, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY];
  if (s3Fields.some(Boolean) && !s3Fields.every(Boolean) && !overrides.objectStorage) {
    throw new Error('对象存储需要同时设置 S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY');
  }

  const config = {
    root,
    publicDir: overrides.publicDir || path.join(root, 'public'),
    dataDir,
    uploadDir,
    dbFile: overrides.dbFile || path.join(dataDir, 'meme-vault.db'),
    host: overrides.host || env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1'),
    port: overrides.port ?? intFromEnv(env.PORT, 3000),
    isProduction,
    sessionTtlMs: overrides.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    maxUploadBytes: overrides.maxUploadBytes ?? 5 * 1024 * 1024,
    maxImageDimension: overrides.maxImageDimension ?? 8192,
    cookieName: overrides.cookieName || 'meme_session',
    cookieSecure: overrides.cookieSecure ?? boolFromEnv(env.COOKIE_SECURE, isProduction),
    trustProxy: overrides.trustProxy ?? boolFromEnv(env.TRUST_PROXY, false),
    objectStorage: overrides.objectStorage || (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? {
      endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1', accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    } : null),
    seedDemoAccounts:
      overrides.seedDemoAccounts ?? env.SEED_DEMO_ACCOUNTS !== '0',
    adminUsername: overrides.adminUsername || env.ADMIN_USERNAME || 'admin',
    adminPassword:
      overrides.adminPassword ||
      env.ADMIN_PASSWORD ||
      (isProduction ? null : 'Admin@123456'),
    reviewerUsername:
      overrides.reviewerUsername || env.REVIEWER_USERNAME || 'reviewer',
    reviewerPassword:
      overrides.reviewerPassword ||
      env.REVIEWER_PASSWORD ||
      (isProduction ? null : 'Review@123456'),
  };

  if (config.isProduction && config.seedDemoAccounts && !config.adminPassword) {
    throw new Error(
      '生产环境必须设置 ADMIN_PASSWORD（至少 8 位），或设置 SEED_DEMO_ACCOUNTS=0 后自行创建账号。'
    );
  }
  if (
    config.isProduction &&
    config.seedDemoAccounts &&
    config.reviewerUsername &&
    !config.reviewerPassword
  ) {
    // Reviewer is optional in production: set REVIEWER_PASSWORD to seed one.
    config.reviewerUsername = null;
  }

  return config;
}

module.exports = { loadConfig, PROJECT_ROOT };

'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim();
}

function validateUsername(username) {
  if (!username) return '请输入用户名';
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username)) {
    return '用户名需为 2–24 位，仅支持中英文、数字、下划线或短横线';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return '请输入密码';
  }
  if (password.length < 8) return '密码至少需要 8 位';
  if (password.length > 128) return '密码不能超过 128 位';
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

async function verifyPassword(password, storedHash) {
  try {
    const [algorithm, n, r, p, saltB64, hashB64] = String(storedHash).split('$');
    if (algorithm !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEMORY,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  const cookies = Object.create(null);
  if (!header) return cookies;
  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index < 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join('; ');
}

module.exports = {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  parseCookies,
  serializeCookie,
  normalizeUsername,
  validateUsername,
  validatePassword,
};

'use strict';

const crypto = require('node:crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function createObjectStorage(config) {
  if (!config) return null;
  const base = new URL(config.endpoint);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('S3_ENDPOINT 必须是 HTTP(S) 地址');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('远程对象存储必须使用 HTTPS');
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/i.test(config.bucket)) throw new Error('S3_BUCKET 格式无效');
  async function request(method, key, body = Buffer.alloc(0), mime = 'application/octet-stream') {
    if (!/^[a-f0-9-]+\.(?:png|jpe?g|gif|webp)$/i.test(key)) throw new Error('对象键格式无效');
    const url = new URL(base.toString());
    url.pathname = `${base.pathname.replace(/\/$/, '')}/${config.bucket}/${key}`;
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = now.slice(0, 8);
    const payloadHash = sha256(body);
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': now,
    };
    if (method === 'PUT') headers['content-type'] = mime;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const canonical = [method, url.pathname, '', canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
    let signing = hmac(`AWS4${config.secretAccessKey}`, date);
    signing = hmac(signing, config.region);
    signing = hmac(signing, 's3');
    signing = hmac(signing, 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(signing, toSign).toString('hex')}`;
    delete headers.host;
    const response = await fetch(url, { method, headers, body: method === 'PUT' ? body : undefined });
    if (!response.ok) throw new Error(`对象存储 ${method} 失败：HTTP ${response.status}`);
    return method === 'GET' ? Buffer.from(await response.arrayBuffer()) : undefined;
  }
  return {
    put: (key, buffer, mime) => request('PUT', key, buffer, mime),
    get: (key) => request('GET', key),
    delete: (key) => request('DELETE', key),
  };
}

module.exports = { createObjectStorage };

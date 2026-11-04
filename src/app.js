'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { handleExtendedApi } = require('./extended-api');
const { createObjectStorage } = require('./object-storage');

const { loadConfig } = require('./config');
const { openDatabase, seedAccounts } = require('./database');
const {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  parseCookies,
  serializeCookie,
  normalizeUsername,
  validateUsername,
  validatePassword,
} = require('./security');
const {
  detectImage,
  cleanText,
  cleanOriginalName,
  titleFromFilename,
} = require('./images');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const EMOJI_SELECT = `
  SELECT e.*, u.username AS owner_username, r.username AS reviewer_username
  FROM emojis e
  JOIN users u ON u.id = e.owner_id
  LEFT JOIN users r ON r.id = e.reviewed_by
`;

const ROLE_LABELS = {
  user: '普通用户',
  reviewer: '审核员',
  admin: '管理员',
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function applyBaseHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendApiError(res, error) {
  sendJson(res, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

async function readRequest(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容超过大小限制');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容超过大小限制');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(req, maxBytes = 32 * 1024) {
  const body = await readRequest(req, maxBytes);
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求内容不是合法的 JSON 对象');
  }
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSameOrigin(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
  };
}

function serializeEmoji(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    deletedAt: row.deleted_at || null,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    status: row.status,
    reviewNote: row.review_note || null,
    reviewedBy: row.reviewer_username || null,
    reviewedAt: row.reviewed_at || null,
    downloadCount: row.download_count,
    createdAt: row.created_at,
    owner: {
      id: row.owner_id,
      username: row.owner_username,
    },
    imageUrl: `/api/emojis/${row.id}/image`,
    thumbnailUrl: row.thumbnail_name ? `/api/emojis/${row.id}/thumbnail` : `/api/emojis/${row.id}/image`,
    downloadUrl: `/api/emojis/${row.id}/download`,
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parsePage(value, fallback, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function makeSession(db, config, userId, res, req) {
  const token = newSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlMs);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_address) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(hashToken(token), userId, now.toISOString(), expiresAt.toISOString(),
    String(req?.headers['user-agent'] || '').slice(0, 200), req ? clientIp(req, config) : null);

  res.setHeader(
    'Set-Cookie',
    serializeCookie(config.cookieName, token, {
      maxAge: Math.floor(config.sessionTtlMs / 1000),
      expires: expiresAt,
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: 'Strict',
    })
  );
}

function clearSession(db, req, config, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  res.setHeader(
    'Set-Cookie',
    serializeCookie(config.cookieName, '', {
      maxAge: 0,
      expires: new Date(0),
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: 'Strict',
    })
  );
}

function authenticate(db, req, config) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(hashToken(token));

  if (!row) return null;
  if (row.disabled_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return publicUser(row);
}

async function serveStatic(req, res, url, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) return false;

  const fullPath = path.resolve(config.publicDir, relative);
  if (fullPath !== config.publicDir && !fullPath.startsWith(config.publicDir + path.sep)) {
    return false;
  }

  let stat;
  try {
    stat = await fsp.stat(fullPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const extension = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fullPath);
    stream.on('error', reject);
    res.on('close', resolve);
    stream.pipe(res);
    res.on('finish', resolve);
  });
  return true;
}

function contentDisposition(type, filename, fallback) {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function streamEmojiFile(req, res, filePath, mimeType, downloadName, fallbackName) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new ApiError(410, 'FILE_MISSING', '表情文件已丢失，请联系管理员');
  }
  if (!stat.isFile()) {
    throw new ApiError(410, 'FILE_MISSING', '表情文件已丢失，请联系管理员');
  }

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': stat.size,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': contentDisposition(
      downloadName ? 'attachment' : 'inline',
      downloadName || fallbackName,
      fallbackName
    ),
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.pipe(res);
    res.on('finish', resolve);
    res.on('close', resolve);
  });
}

async function ensureLocalFile(config, objectStorage, key) {
  const target = path.join(config.uploadDir, key);
  try { await fsp.access(target); }
  catch {
    if (!objectStorage) return;
    const buffer = await objectStorage.get(key);
    await fsp.writeFile(target, buffer);
  }
}

function createEmojiQueries(db) {
  const getById = db.prepare(`${EMOJI_SELECT} WHERE e.id = ?`);

  function list({ status, ownerId, q, category, sort, page, pageSize }) {
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push('e.status = ?');
      params.push(status);
    }
    if (ownerId) {
      clauses.push('e.owner_id = ?');
      params.push(ownerId);
    }
    if (category && category !== '全部') {
      clauses.push('e.category = ?');
      params.push(category);
    }
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      clauses.push(
        "(e.title LIKE ? ESCAPE '\\' OR e.category LIKE ? ESCAPE '\\' OR e.tags LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"
      );
      params.push(pattern, pattern, pattern, pattern);
    }

    clauses.push('e.deleted_at IS NULL');
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM emojis e JOIN users u ON u.id = e.owner_id ${where}`
      )
      .get(...params).total;

    const orderBy =
      sort === 'popular'
        ? 'e.download_count DESC, e.created_at DESC, e.id DESC'
        : 'e.created_at DESC, e.id DESC';
    const offset = (page - 1) * pageSize;
    const rows = db
      .prepare(
        `${EMOJI_SELECT} ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    return { items: rows.map(serializeEmoji), total };
  }

  function categories() {
    return db
      .prepare(
        `SELECT category AS name, COUNT(*) AS count
         FROM emojis
         WHERE status = 'approved' AND deleted_at IS NULL
         GROUP BY category
         ORDER BY count DESC, category ASC
         LIMIT 40`
      )
      .all();
  }

  return { getById, list, categories };
}

function validateReviewBody(body) {
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new ApiError(400, 'INVALID_DECISION', '审核结果必须是通过或驳回');
  }
  const note = cleanText(body.note, 200, '');
  return { decision, note };
}

async function handleApi(req, res, url, context) {
  const { db, config, dummyHash, loginFailures, rateLimits, queries, objectStorage } = context;
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const method = req.method || 'GET';
  const enforce = (scope, identity, max, durationMs) => {
    const key = `${scope}:${identity}`;
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + durationMs };
      rateLimits.set(key, entry);
    }
    if (++entry.count > max) throw new ApiError(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');
  };

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'meme-vault', time: new Date().toISOString() });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    enforce('register', clientIp(req, config), 5, 60 * 60 * 1000);
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    const usernameError = validateUsername(username);
    if (usernameError) throw new ApiError(400, 'INVALID_USERNAME', usernameError);
    const passwordError = validatePassword(body.password);
    if (passwordError) throw new ApiError(400, 'INVALID_PASSWORD', passwordError);

    const passwordHash = await hashPassword(body.password);
    let result;
    try {
      result = db
        .prepare(
          'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(username, passwordHash, 'user', new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名已经有人使用了');
      }
      throw error;
    }

    const user = publicUser(
      db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(result.lastInsertRowid)
    );
    makeSession(db, config, user.id, res, req);
    return sendJson(res, 201, { user });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    enforce('login-ip', clientIp(req, config), 40, 15 * 60 * 1000);
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      throw new ApiError(400, 'CREDENTIALS_REQUIRED', '请输入用户名和密码');
    }

    const key = `${clientIp(req, config)}|${username.toLowerCase()}`;
    const now = Date.now();
    const entry = loginFailures.get(key);
    if (entry && entry.expiresAt > now && entry.count >= 8) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请 15 分钟后再试');
    }

    const row = db
      .prepare('SELECT id, username, role, password_hash, disabled_at FROM users WHERE username = ? COLLATE NOCASE')
      .get(username);
    const valid = row
      ? await verifyPassword(password, row.password_hash)
      : await verifyPassword(password, dummyHash);

    if (!row || !valid) {
      if (!entry || entry.expiresAt <= now) {
        loginFailures.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
      } else {
        entry.count += 1;
      }
      throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }

    if (row.disabled_at) throw new ApiError(403, 'ACCOUNT_DISABLED', '账号已停用，请联系管理员');

    loginFailures.delete(key);
    const user = publicUser(row);
    makeSession(db, config, user.id, res, req);
    return sendJson(res, 200, { user });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearSession(db, req, config, res);
    return sendJson(res, 200, { ok: true });
  }

  const auth = authenticate(db, req, config);

  if (pathname === '/api/auth/me' && method === 'GET') {
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    return sendJson(res, 200, { user: auth });
  }

  if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');

  if (await handleExtendedApi({ req, res, url, pathname, method, auth, context,
    ApiError, sendJson, readJson, readRequest, serializeEmoji, cleanText,
    detectImage, cleanOriginalName, titleFromFilename, streamEmojiFile, clientIp,
    hashPassword, verifyPassword, validatePassword, hashToken, parseCookies })) return;

  if (pathname === '/api/emojis' && method === 'GET') {
    const q = cleanText(url.searchParams.get('q'), 50, '');
    const category = cleanText(url.searchParams.get('category'), 20, '全部');
    const sort = url.searchParams.get('sort') === 'popular' ? 'popular' : 'latest';
    const page = parsePage(url.searchParams.get('page'), 1, 1000);
    const pageSize = parsePage(url.searchParams.get('pageSize'), 24, 48);
    const result = queries.list({
      status: 'approved',
      q,
      category,
      sort,
      page,
      pageSize,
    });
    return sendJson(res, 200, { ...result, page, pageSize });
  }

  if (pathname === '/api/emojis' && method === 'POST') {
    enforce('upload', auth.id, 20, 60 * 60 * 1000);
    const contentType = req.headers['content-type'] || '';
    if (!/^multipart\/form-data;/i.test(contentType) || !/boundary=/i.test(contentType)) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '上传请求必须使用 multipart/form-data');
    }

    const maxBody = config.maxUploadBytes * 10 + 4 * 1024 * 1024;
    const body = await readRequest(req, maxBody);
    let form;
    try {
      form = await new Response(body, {
        headers: { 'content-type': contentType },
      }).formData();
    } catch {
      throw new ApiError(400, 'INVALID_MULTIPART', '无法解析上传内容');
    }

    const files = form.getAll('file').filter((value) => typeof value !== 'string');
    const thumbnails = form.getAll('thumbnail').filter((value) => typeof value !== 'string');
    if (files.length === 0) throw new ApiError(400, 'FILE_REQUIRED', '请选择图片');
    if (files.length > 10) throw new ApiError(400, 'TOO_MANY_FILES', '每次最多上传 10 张图片');
    const prepared = [];
    for (const [index, file] of files.entries()) {
      if (!file.size) throw new ApiError(400, 'EMPTY_FILE', `${file.name} 是空文件`);
      if (file.size > config.maxUploadBytes) throw new ApiError(413, 'FILE_TOO_LARGE', `${file.name} 超过 5 MB`);
      const buffer = Buffer.from(await file.arrayBuffer());
      const image = detectImage(buffer);
      if (!image) throw new ApiError(415, 'UNSUPPORTED_IMAGE', `${file.name} 不是支持的图片`);
      if (image.width > config.maxImageDimension || image.height > config.maxImageDimension) {
        throw new ApiError(400, 'IMAGE_TOO_LARGE', `${file.name} 的宽高超过限制`);
      }
      const originalName = cleanOriginalName(file.name);
      let thumbnail = null;
      if (thumbnails[index]) {
        const thumbBuffer = Buffer.from(await thumbnails[index].arrayBuffer());
        const thumbImage = detectImage(thumbBuffer);
        if (thumbBuffer.length > 300 * 1024 || !thumbImage || thumbImage.mime !== 'image/webp' ||
          thumbImage.width > 400 || thumbImage.height > 400) {
          throw new ApiError(400, 'INVALID_THUMBNAIL', '缩略图格式或尺寸无效');
        }
        thumbnail = { buffer: thumbBuffer, name: `${crypto.randomUUID()}.webp` };
      }
      prepared.push({ buffer, image, originalName,
        title: files.length === 1 ? cleanText(form.get('title'), 60, titleFromFilename(originalName)) : titleFromFilename(originalName),
        storedName: `${crypto.randomUUID()}${image.extension}`, thumbnail });
    }
    const category = cleanText(form.get('category'), 20, '未分类');
    const tags = [...new Set(cleanText(form.get('tags'), 160, '').split(/[,，]/).map((v) => cleanText(v, 20, '')).filter(Boolean))].slice(0, 5).join(',');
    const now = new Date().toISOString();
    const autoApproved = auth.role === 'reviewer' || auth.role === 'admin';
    const created = [];
    try {
      for (const item of prepared) {
        await fsp.writeFile(path.join(config.uploadDir, item.storedName), item.buffer, { flag: 'wx' });
        if (item.thumbnail) await fsp.writeFile(path.join(config.uploadDir, item.thumbnail.name), item.thumbnail.buffer, { flag: 'wx' });
      }
      if (objectStorage) {
        for (const item of prepared) {
          await objectStorage.put(item.storedName, item.buffer, item.image.mime);
          if (item.thumbnail) await objectStorage.put(item.thumbnail.name, item.thumbnail.buffer, 'image/webp');
        }
      }
      db.exec('BEGIN');
      const insert = db.prepare(`INSERT INTO emojis
        (owner_id, title, category, tags, stored_name, thumbnail_name, original_name, mime_type,
        size_bytes, width, height, status, reviewed_by, reviewed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of prepared) {
        const result = insert.run(auth.id, item.title, category, tags, item.storedName,
          item.thumbnail?.name || null,
          item.originalName, item.image.mime, item.buffer.length, item.image.width,
          item.image.height, autoApproved ? 'approved' : 'pending',
          autoApproved ? auth.id : null, autoApproved ? now : null, now);
        created.push(serializeEmoji(queries.getById.get(result.lastInsertRowid)));
      }
      db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)').run(category, now);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Transaction was not opened. */ }
      await Promise.all(prepared.flatMap((item) => [item.storedName, item.thumbnail?.name].filter(Boolean))
        .map((name) => fsp.rm(path.join(config.uploadDir, name), { force: true }).catch(() => {})));
      if (objectStorage) await Promise.all(prepared.flatMap((item) => [item.storedName, item.thumbnail?.name].filter(Boolean))
        .map((name) => objectStorage.delete(name).catch(() => {})));
      throw error;
    }
    return sendJson(res, 201, {
      emoji: created[0], items: created,
      message: `${created.length} 张上传成功${autoApproved ? '，已直接发布' : '，等待审核'}`,
    });
  }

  if (pathname === '/api/emojis/mine' && method === 'GET') {
    const result = queries.list({
      ownerId: auth.id,
      sort: 'latest',
      page: 1,
      pageSize: 200,
    });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/categories' && method === 'GET') {
    return sendJson(res, 200, { items: queries.categories() });
  }

  if (pathname === '/api/review/count' && method === 'GET') {
    if (auth.role !== 'reviewer' && auth.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', '只有审核员或管理员可以查看审核队列');
    }
    const row = db.prepare("SELECT COUNT(*) AS total FROM emojis WHERE status = 'pending' AND deleted_at IS NULL").get();
    return sendJson(res, 200, { total: row.total });
  }

  if (pathname === '/api/review/queue' && method === 'GET') {
    if (auth.role !== 'reviewer' && auth.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', '只有审核员或管理员可以查看审核队列');
    }
    const result = queries.list({
      status: 'pending',
      sort: 'latest',
      page: 1,
      pageSize: 100,
    });
    return sendJson(res, 200, result);
  }

  const reviewMatch = pathname.match(/^\/api\/emojis\/(\d+)\/review$/);
  if (reviewMatch && method === 'POST') {
    if (auth.role !== 'reviewer' && auth.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', '只有审核员或管理员可以审核');
    }
    const id = Number(reviewMatch[1]);
    const emoji = queries.getById.get(id);
    if (!emoji) throw new ApiError(404, 'NOT_FOUND', '表情不存在');
    if (emoji.deleted_at) throw new ApiError(404, 'NOT_FOUND', '表情不存在');
    if (emoji.status !== 'pending') {
      throw new ApiError(409, 'ALREADY_REVIEWED', '这条内容已经被审核过了');
    }
    if (emoji.owner_id === auth.id) {
      throw new ApiError(403, 'SELF_REVIEW', '不能审核自己上传的内容');
    }

    const body = await readJson(req);
    const { decision, note } = validateReviewBody(body);
    db.prepare(
      `UPDATE emojis
       SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(
      decision,
      note || null,
      auth.id,
      new Date().toISOString(),
      id
    );
    db.prepare('INSERT INTO audit_events (actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(auth.id, 'review', 'emoji', id, JSON.stringify({ decision, note }), new Date().toISOString());

    return sendJson(res, 200, {
      emoji: serializeEmoji(queries.getById.get(id)),
      message: decision === 'approved' ? '已通过审核并发布' : '已驳回',
    });
  }

  const itemMatch = pathname.match(/^\/api\/emojis\/(\d+)(?:\/(image|download|thumbnail))?$/);
  if (itemMatch) {
    const id = Number(itemMatch[1]);
    const action = itemMatch[2];
    const emoji = queries.getById.get(id);
    if (!emoji) throw new ApiError(404, 'NOT_FOUND', '表情不存在');
    if (emoji.deleted_at && auth.role !== 'admin') throw new ApiError(404, 'NOT_FOUND', '表情不存在');

    const isStaff = auth.role === 'reviewer' || auth.role === 'admin';
    const canAccess =
      emoji.status === 'approved' || emoji.owner_id === auth.id || isStaff;
    if (!canAccess) {
      throw new ApiError(403, 'FORBIDDEN', '这条表情还在审核中，暂时无法查看');
    }

    const filePath = path.join(config.uploadDir, emoji.stored_name);

    if (action === 'image' && (method === 'GET' || method === 'HEAD')) {
      await ensureLocalFile(config, objectStorage, emoji.stored_name);
      return streamEmojiFile(
        req,
        res,
        filePath,
        emoji.mime_type,
        null,
        `emoji-${emoji.id}${path.extname(emoji.stored_name)}`
      );
    }

    if (action === 'thumbnail' && (method === 'GET' || method === 'HEAD')) {
      await ensureLocalFile(config, objectStorage, emoji.thumbnail_name || emoji.stored_name);
      return streamEmojiFile(req, res, path.join(config.uploadDir, emoji.thumbnail_name || emoji.stored_name),
        emoji.thumbnail_name ? 'image/webp' : emoji.mime_type, null, `emoji-${id}.webp`);
    }

    if (action === 'download' && (method === 'GET' || method === 'HEAD')) {
      if (method === 'GET') enforce('download', auth.id, 120, 15 * 60 * 1000);
      await ensureLocalFile(config, objectStorage, emoji.stored_name);
      const extension = path.extname(emoji.stored_name);
      const downloadName = `${emoji.title}${extension}`;
      if (method === 'GET') {
        db.prepare('UPDATE emojis SET download_count = download_count + 1 WHERE id = ?').run(id);
      }
      return streamEmojiFile(
        req,
        res,
        filePath,
        emoji.mime_type,
        downloadName,
        `emoji-${emoji.id}${extension}`
      );
    }

    if (!action && method === 'PATCH') {
      const isAdmin = auth.role === 'admin';
      if (!isAdmin && emoji.owner_id !== auth.id) {
        throw new ApiError(403, 'FORBIDDEN', '只能修改自己上传的内容');
      }
      if (!isAdmin && emoji.status === 'approved') {
        throw new ApiError(403, 'FORBIDDEN', '已发布的内容请联系管理员修改');
      }
      const body = await readJson(req);
      const updates = [];
      const params = [];
      if (Object.hasOwn(body, 'title')) {
        const title = cleanText(body.title, 60, '');
        if (!title) throw new ApiError(400, 'INVALID_TITLE', '标题不能为空');
        updates.push('title = ?');
        params.push(title);
      }
      if (Object.hasOwn(body, 'category')) {
        const category = cleanText(body.category, 20, '');
        if (!category) throw new ApiError(400, 'INVALID_CATEGORY', '分类不能为空');
        updates.push('category = ?');
        params.push(category);
      }
      if (Object.hasOwn(body, 'tags')) {
        const tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(/[,，]/);
        updates.push('tags = ?');
        params.push([...new Set(tags.map((v) => cleanText(v, 20, '')).filter(Boolean))].slice(0, 5).join(','));
      }
      if (updates.length === 0) {
        throw new ApiError(400, 'NOTHING_TO_UPDATE', '没有可修改的字段');
      }
      params.push(id);
      db.prepare(`UPDATE emojis SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      db.prepare('INSERT INTO audit_events (actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(auth.id, 'edit', 'emoji', id, JSON.stringify(body), new Date().toISOString());
      return sendJson(res, 200, { emoji: serializeEmoji(queries.getById.get(id)) });
    }

    if (!action && method === 'DELETE') {
      const isAdmin = auth.role === 'admin';
      const canDelete = isAdmin || (emoji.owner_id === auth.id && emoji.status !== 'approved');
      if (!canDelete) {
        throw new ApiError(403, 'FORBIDDEN', '没有删除这条内容的权限');
      }
      db.prepare('UPDATE emojis SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      db.prepare('INSERT INTO audit_events (actor_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(auth.id, 'delete', 'emoji', id, new Date().toISOString());
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new ApiError(404, 'NOT_FOUND', '接口不存在');
}

async function createApp(options = {}) {
  const config = loadConfig(process.env, options);
  const db = openDatabase(config);
  const seeded = await seedAccounts(db, config);
  const dummyHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
  const loginFailures = new Map();
  const rateLimits = new Map();
  const queries = createEmojiQueries(db);
  const objectStorage = createObjectStorage(config.objectStorage);

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
    for (const [key, entry] of loginFailures) {
      if (entry.expiresAt <= now) loginFailures.delete(key);
    }
    for (const [key, entry] of rateLimits) {
      if (entry.until <= now) rateLimits.delete(key);
    }
  }, 10 * 60 * 1000);
  cleanupTimer.unref();

  const context = { db, config, dummyHash, loginFailures, rateLimits, queries, objectStorage };

  const server = http.createServer(async (req, res) => {
    applyBaseHeaders(res);
    const startedAt = Date.now();

    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `http://${host}`);
      const isApi = url.pathname.startsWith('/api/');
      const isSafeMethod = req.method === 'GET' || req.method === 'HEAD';

      if (isApi) {
        res.setHeader('Cache-Control', 'no-store');
        if (!isSafeMethod && !isSameOrigin(req)) {
          throw new ApiError(403, 'CROSS_ORIGIN_BLOCKED', '已阻止跨站请求');
        }
        await handleApi(req, res, url, context);
      } else {
        const served = await serveStatic(req, res, url, config);
        if (!served) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 413) res.setHeader('Connection', 'close');
        sendApiError(res, error);
      } else {
        console.error(`[${req.method} ${req.url}]`, error);
        if (!res.headersSent) {
          sendApiError(
            res,
            new ApiError(500, 'INTERNAL_ERROR', '服务器开小差了，请稍后再试')
          );
        } else {
          res.destroy();
        }
      }
    } finally {
      if (process.env.DEBUG_REQUESTS === '1') {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`);
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
  }

  async function close() {
    clearInterval(cleanupTimer);
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    db.close();
  }

  return { server, db, config, seeded, listen, close };
}

module.exports = { createApp, ApiError };

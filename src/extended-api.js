'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function audit(db, actorId, action, targetType, targetId, details = null) {
  db.prepare(`INSERT INTO audit_events (actor_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(actorId, action, targetType, targetId,
    details ? JSON.stringify(details) : null, new Date().toISOString());
}

function limit(context, key, max, windowMs, ApiError) {
  const now = Date.now();
  const entry = context.rateLimits.get(key);
  if (!entry || entry.until < now) {
    context.rateLimits.set(key, { count: 1, until: now + windowMs });
    return;
  }
  if (++entry.count > max) throw new ApiError(429, 'RATE_LIMITED', '操作太频繁，请稍后重试');
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipFiles(files) {
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const filename = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directorySize = directory.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end]);
}

async function handleExtendedApi(h) {
  const { req, res, url, pathname, method, auth, context, ApiError, sendJson,
    readJson, readRequest, serializeEmoji, cleanText, validatePassword,
    hashPassword, verifyPassword, hashToken, parseCookies } = h;
  const { db, config, queries, objectStorage } = context;
  const admin = auth.role === 'admin';
  const staff = admin || auth.role === 'reviewer';
  const requireAdmin = () => { if (!admin) throw new ApiError(403, 'FORBIDDEN', '仅管理员可操作'); };
  const requireStaff = () => { if (!staff) throw new ApiError(403, 'FORBIDDEN', '仅审核员或管理员可操作'); };
  const limited = (scope, max, ms) => limit(context, `${scope}:${auth.id}:${h.clientIp(req, config)}`, max, ms, ApiError);
  const page = Math.min(10000, Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1));

  if (pathname === '/api/categories' && method === 'GET') {
    const items = db.prepare(`SELECT c.id, c.name, COUNT(e.id) AS count FROM categories c
      LEFT JOIN emojis e ON e.category = c.name AND e.status = 'approved' AND e.deleted_at IS NULL
      GROUP BY c.id ORDER BY count DESC, c.name ASC`).all();
    return sendJson(res, 200, { items }), true;
  }
  if (pathname === '/api/categories' && method === 'POST') {
    requireAdmin();
    const name = cleanText((await readJson(req)).name, 20, '');
    if (!name) throw new ApiError(400, 'INVALID_CATEGORY', '请输入分类名称');
    db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
    audit(db, auth.id, 'category_create', 'category', null, { name });
    return sendJson(res, 201, { name }), true;
  }
  const categoryMatch = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (categoryMatch && (method === 'PATCH' || method === 'DELETE')) {
    requireAdmin();
    const id = Number(categoryMatch[1]);
    const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '分类不存在');
    if (method === 'PATCH') {
      const name = cleanText((await readJson(req)).name, 20, '');
      if (!name) throw new ApiError(400, 'INVALID_CATEGORY', '请输入分类名称');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
        db.prepare('UPDATE emojis SET category = ? WHERE category = ?').run(name, row.name);
        audit(db, auth.id, 'category_rename', 'category', id, { from: row.name, to: name });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return sendJson(res, 200, { name }), true;
    }
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE emojis SET category = '未分类' WHERE category = ?").run(row.name);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)').run('未分类', new Date().toISOString());
      audit(db, auth.id, 'category_delete', 'category', id, { name: row.name });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return sendJson(res, 200, { ok: true }), true;
  }

  if (pathname === '/api/favorites' && method === 'GET') {
    const rows = db.prepare(`SELECT e.*, u.username AS owner_username, r.username AS reviewer_username
      FROM favorites f JOIN emojis e ON e.id = f.emoji_id
      JOIN users u ON u.id = e.owner_id LEFT JOIN users r ON r.id = e.reviewed_by
      WHERE f.user_id = ? AND e.status = 'approved' AND e.deleted_at IS NULL
      ORDER BY f.created_at DESC LIMIT 200`).all(auth.id);
    return sendJson(res, 200, { items: rows.map(serializeEmoji) }), true;
  }
  const favoriteMatch = pathname.match(/^\/api\/favorites\/(\d+)$/);
  if (favoriteMatch && (method === 'POST' || method === 'DELETE')) {
    const id = Number(favoriteMatch[1]);
    const row = db.prepare("SELECT id FROM emojis WHERE id = ? AND status = 'approved' AND deleted_at IS NULL").get(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '表情不存在');
    if (method === 'POST') db.prepare('INSERT OR IGNORE INTO favorites VALUES (?, ?, ?)').run(auth.id, id, new Date().toISOString());
    else db.prepare('DELETE FROM favorites WHERE user_id = ? AND emoji_id = ?').run(auth.id, id);
    return sendJson(res, 200, { favorite: method === 'POST' }), true;
  }
  if (pathname === '/api/rankings' && method === 'GET') {
    const rows = db.prepare(`SELECT e.*, u.username AS owner_username, r.username AS reviewer_username
      FROM emojis e JOIN users u ON u.id = e.owner_id LEFT JOIN users r ON r.id = e.reviewed_by
      WHERE e.status = 'approved' AND e.deleted_at IS NULL
      ORDER BY e.download_count DESC, e.created_at DESC LIMIT 20`).all();
    return sendJson(res, 200, { items: rows.map(serializeEmoji) }), true;
  }

  if (pathname === '/api/review/batch' && method === 'POST') {
    requireStaff(); limited('review', 20, 60_000);
    const body = await readJson(req);
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(Number) : [])];
    if (!ids.length || ids.length > 50 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
      throw new ApiError(400, 'INVALID_IDS', '每次请选择 1–50 条内容');
    if (!['approved', 'rejected'].includes(body.decision)) throw new ApiError(400, 'INVALID_DECISION', '审核结果无效');
    const note = cleanText(body.note, 200, '');
    const get = db.prepare('SELECT owner_id, status, deleted_at FROM emojis WHERE id = ?');
    for (const id of ids) {
      const item = get.get(id);
      if (!item || item.deleted_at || item.status !== 'pending' || item.owner_id === auth.id)
        throw new ApiError(409, 'INVALID_REVIEW_ITEM', `编号 ${id} 无法审核`);
    }
    db.exec('BEGIN');
    try {
      const update = db.prepare(`UPDATE emojis SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`);
      for (const id of ids) {
        update.run(body.decision, note || null, auth.id, new Date().toISOString(), id);
        audit(db, auth.id, 'review', 'emoji', id, { decision: body.decision, note });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return sendJson(res, 200, { count: ids.length }), true;
  }

  if (pathname === '/api/admin/emojis' && method === 'GET') {
    requireAdmin();
    const status = url.searchParams.get('status');
    const clauses = [status === 'deleted' ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL'];
    const params = [];
    const q = cleanText(url.searchParams.get('q'), 50, '');
    if (q) {
      clauses.push('(e.title LIKE ? OR e.category LIKE ? OR e.tags LIKE ? OR u.username LIKE ?)');
      params.push(...Array(4).fill(`%${q}%`));
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM emojis e JOIN users u ON u.id = e.owner_id ${where}`).get(...params).total;
    const rows = db.prepare(`SELECT e.*, u.username AS owner_username, r.username AS reviewer_username
      FROM emojis e JOIN users u ON u.id = e.owner_id LEFT JOIN users r ON r.id = e.reviewed_by
      ${where} ORDER BY e.created_at DESC LIMIT 30 OFFSET ?`).all(...params, (page - 1) * 30);
    return sendJson(res, 200, { items: rows.map(serializeEmoji), total, page, pageSize: 30 }), true;
  }
  const restoreMatch = pathname.match(/^\/api\/admin\/emojis\/(\d+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    requireAdmin();
    const id = Number(restoreMatch[1]);
    const result = db.prepare('UPDATE emojis SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND', '未找到已删除内容');
    audit(db, auth.id, 'restore', 'emoji', id);
    return sendJson(res, 200, { emoji: serializeEmoji(queries.getById.get(id)) }), true;
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    requireAdmin();
    const total = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    const items = db.prepare(`SELECT u.id, u.username, u.role, u.disabled_at AS disabledAt, u.created_at AS createdAt,
      (SELECT COUNT(*) FROM emojis e WHERE e.owner_id = u.id AND e.deleted_at IS NULL) AS uploadCount
      FROM users u ORDER BY u.created_at DESC LIMIT 30 OFFSET ?`).all((page - 1) * 30);
    return sendJson(res, 200, { items, total, page, pageSize: 30 }), true;
  }
  const roleMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/);
  if (roleMatch && method === 'PATCH') {
    requireAdmin();
    const id = Number(roleMatch[1]);
    const role = (await readJson(req)).role;
    if (!['user', 'reviewer', 'admin'].includes(role)) throw new ApiError(400, 'INVALID_ROLE', '角色无效');
    if (id === auth.id && role !== 'admin') throw new ApiError(409, 'SELF_DEMOTION', '不能取消自己的管理员权限');
    const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?').run(id, auth.id);
    audit(db, auth.id, 'role_change', 'user', id, { role });
    return sendJson(res, 200, { ok: true }), true;
  }
  const statusMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
  if (statusMatch && method === 'PATCH') {
    requireAdmin();
    const id = Number(statusMatch[1]);
    const disabled = (await readJson(req)).disabled;
    if (typeof disabled !== 'boolean') throw new ApiError(400, 'INVALID_STATUS', '状态无效');
    if (id === auth.id && disabled) throw new ApiError(409, 'SELF_DISABLE', '不能停用自己的账号');
    const result = db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled ? new Date().toISOString() : null, id);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, auth.id, disabled ? 'user_disable' : 'user_enable', 'user', id);
    return sendJson(res, 200, { disabled }), true;
  }
  const resetMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/password$/);
  if (resetMatch && method === 'POST') {
    requireAdmin(); limited('admin_reset', 5, 15 * 60_000);
    const id = Number(resetMatch[1]);
    const password = (await readJson(req)).password;
    const error = validatePassword(password);
    if (error) throw new ApiError(400, 'INVALID_PASSWORD', error);
    const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, auth.id, 'password_reset', 'user', id);
    return sendJson(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/admin/audit' && method === 'GET') {
    requireAdmin();
    const total = db.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total;
    const items = db.prepare(`SELECT a.id, a.action, a.target_type AS targetType,
      a.target_id AS targetId, a.details, a.created_at AS createdAt,
      u.username AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 50 OFFSET ?`).all((page - 1) * 50);
    return sendJson(res, 200, { items, total, page, pageSize: 50 }), true;
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    limited('password', 5, 15 * 60_000);
    const body = await readJson(req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(auth.id);
    if (!await verifyPassword(body.currentPassword || '', row.password_hash))
      throw new ApiError(401, 'WRONG_PASSWORD', '当前密码不正确');
    const error = validatePassword(body.newPassword);
    if (error) throw new ApiError(400, 'INVALID_PASSWORD', error);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), auth.id);
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(auth.id, hashToken(token));
    audit(db, auth.id, 'password_change', 'user', auth.id);
    return sendJson(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/auth/sessions' && method === 'GET') {
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    const currentHash = hashToken(token);
    const items = db.prepare(`SELECT token_hash, created_at AS createdAt,
      expires_at AS expiresAt, user_agent AS userAgent, ip_address AS ipAddress
      FROM sessions WHERE user_id = ? ORDER BY created_at DESC`).all(auth.id)
      .map((s) => ({ id: s.token_hash, current: s.token_hash === currentHash,
        createdAt: s.createdAt, expiresAt: s.expiresAt, userAgent: s.userAgent, ipAddress: s.ipAddress }));
    return sendJson(res, 200, { items }), true;
  }
  const sessionMatch = pathname.match(/^\/api\/auth\/sessions\/([a-f0-9]{64})$/);
  if (sessionMatch && method === 'DELETE') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(sessionMatch[1], auth.id);
    audit(db, auth.id, 'session_revoke', 'user', auth.id);
    return sendJson(res, 200, { ok: true }), true;
  }

  if (pathname === '/api/emojis/download-zip' && method === 'POST') {
    limited('zip', 10, 15 * 60_000);
    const body = await readJson(req);
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(Number) : [])];
    if (!ids.length || ids.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
      throw new ApiError(400, 'INVALID_IDS', '每次请选择 1–20 张表情');
    const get = db.prepare('SELECT * FROM emojis WHERE id = ?');
    const files = [];
    for (const id of ids) {
      const item = get.get(id);
      if (!item || item.deleted_at || (item.status !== 'approved' && item.owner_id !== auth.id && !staff))
        throw new ApiError(403, 'FORBIDDEN', `无权下载编号 ${id}`);
      let data;
      try { data = await fs.readFile(path.join(config.uploadDir, item.stored_name)); }
      catch { if (!objectStorage) throw new ApiError(410, 'FILE_MISSING', '图片文件已丢失'); data = await objectStorage.get(item.stored_name); }
      const safeTitle = item.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 50);
      files.push({ name: `${id}-${safeTitle}${path.extname(item.stored_name)}`, data });
    }
    const archive = zipFiles(files);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length,
      'Content-Disposition': 'attachment; filename="meme-vault.zip"', 'Cache-Control': 'private, no-store' });
    res.end(archive);
    const update = db.prepare('UPDATE emojis SET download_count = download_count + 1 WHERE id = ?');
    for (const id of ids) update.run(id);
    return true;
  }
  return false;
}

module.exports = { handleExtendedApi };

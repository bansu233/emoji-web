'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../src/app');
const { createObjectStorage } = require('../src/object-storage');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
  }

  async request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let body = options.body;
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return response;
  }

  async json(pathname, options) {
    const response = await this.request(pathname, options);
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }
}

test('最小闭环：注册、上传、审核、列表、下载', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meme-vault-test-'));
  const app = await createApp({
    root: path.resolve(__dirname, '..'),
    dataDir: path.join(tempRoot, 'data'),
    uploadDir: path.join(tempRoot, 'uploads'),
    dbFile: path.join(tempRoot, 'data', 'test.db'),
    port: 0,
    host: '127.0.0.1',
    cookieSecure: false,
    seedDemoAccounts: true,
    adminUsername: 'admin_test',
    adminPassword: 'AdminTest@123',
    reviewerUsername: 'reviewer_test',
    reviewerPassword: 'ReviewTest@123',
  });

  t.after(async () => {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await t.test('健康检查与未登录拦截', async () => {
    const health = await new Client(baseUrl).json('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.ok, true);

    const me = await new Client(baseUrl).json('/api/auth/me');
    assert.equal(me.response.status, 401);
  });

  const user = new Client(baseUrl);
  let uploadedId;

  await t.test('注册普通用户并写入会话', async () => {
    const { response, payload } = await user.json('/api/auth/register', {
      method: 'POST',
      body: { username: '测试用户', password: 'UserTest@123' },
    });
    assert.equal(response.status, 201);
    assert.equal(payload.user.role, 'user');
    assert.ok(user.cookie.startsWith('meme_session='));
  });

  await t.test('上传单张 PNG 后进入待审核', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), '开心.png');
    form.append('title', '开心转圈');
    form.append('category', '开心');
    const { response, payload } = await user.json('/api/emojis', {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 201);
    assert.equal(payload.emoji.status, 'pending');
    assert.equal(payload.emoji.title, '开心转圈');
    assert.equal(payload.emoji.width, 1);
    uploadedId = payload.emoji.id;
  });

  await t.test('公开列表不显示待审核内容，我的上传可见', async () => {
    const publicList = await user.json('/api/emojis');
    assert.equal(publicList.response.status, 200);
    assert.equal(publicList.payload.total, 0);

    const mine = await user.json('/api/emojis/mine');
    assert.equal(mine.payload.total, 1);
    assert.equal(mine.payload.items[0].status, 'pending');
  });

  const reviewer = new Client(baseUrl);
  await t.test('审核员登录并通过内容', async () => {
    const login = await reviewer.json('/api/auth/login', {
      method: 'POST',
      body: { username: 'reviewer_test', password: 'ReviewTest@123' },
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.payload.user.role, 'reviewer');

    const queue = await reviewer.json('/api/review/queue');
    assert.equal(queue.payload.total, 1);

    const review = await reviewer.json(`/api/emojis/${uploadedId}/review`, {
      method: 'POST',
      body: { decision: 'approved', note: '清晰可用' },
    });
    assert.equal(review.response.status, 200);
    assert.equal(review.payload.emoji.status, 'approved');
  });

  await t.test('审核通过后出现在公开列表且可下载', async () => {
    const list = await user.json('/api/emojis');
    assert.equal(list.payload.total, 1);
    assert.equal(list.payload.items[0].title, '开心转圈');

    const download = await user.request(`/api/emojis/${uploadedId}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal((await download.arrayBuffer()).byteLength, PNG_1X1.length);

    const mine = await user.json('/api/emojis/mine');
    assert.equal(mine.payload.items[0].downloadCount, 1);
  });

  await t.test('跨站写请求被拒绝', async () => {
    const response = await user.request('/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
  });

  const admin = new Client(baseUrl);
  await t.test('批量上传、批量审核与审计', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), '甲.png');
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), '乙.png');
    form.append('thumbnail', new Blob([WEBP_1X1], { type: 'image/webp' }), '甲.webp');
    form.append('thumbnail', new Blob([WEBP_1X1], { type: 'image/webp' }), '乙.webp');
    form.append('category', '开心');
    form.append('tags', '可爱, 动图');
    const upload = await user.json('/api/emojis', { method: 'POST', body: form });
    assert.equal(upload.response.status, 201);
    assert.equal(upload.payload.items.length, 2);
    assert.deepEqual(upload.payload.items[0].tags, ['可爱', '动图']);
    const thumbnail = await user.request(upload.payload.items[0].thumbnailUrl);
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.equal((await thumbnail.arrayBuffer()).byteLength, WEBP_1X1.length);
    const ids = upload.payload.items.map((item) => item.id);
    const batch = await reviewer.json('/api/review/batch', { method: 'POST', body: { ids, decision: 'approved' } });
    assert.equal(batch.response.status, 200);
    assert.equal(batch.payload.count, 2);
    const login = await admin.json('/api/auth/login', { method: 'POST', body: { username: 'admin_test', password: 'AdminTest@123' } });
    assert.equal(login.response.status, 200);
    const audit = await admin.json('/api/admin/audit');
    assert.ok(audit.payload.items.some((item) => item.action === 'review'));
  });

  await t.test('收藏、排行、ZIP 下载', async () => {
    const favorite = await user.json(`/api/favorites/${uploadedId}`, { method: 'POST' });
    assert.equal(favorite.payload.favorite, true);
    const list = await user.json('/api/favorites');
    assert.equal(list.payload.items[0].id, uploadedId);
    const zip = await user.request('/api/emojis/download-zip', { method: 'POST', body: { ids: [uploadedId] } });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
    const ranking = await user.json('/api/rankings');
    assert.equal(ranking.payload.items[0].id, uploadedId);
  });

  await t.test('管理员修改、删除、恢复、分类与角色', async () => {
    const edit = await admin.json(`/api/emojis/${uploadedId}`, { method: 'PATCH', body: { title: '改过的标题', tags: ['经典'] } });
    assert.equal(edit.payload.emoji.title, '改过的标题');
    const removed = await admin.json(`/api/emojis/${uploadedId}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 200);
    assert.equal((await user.json('/api/emojis')).payload.items.some((item) => item.id === uploadedId), false);
    assert.equal((await admin.json('/api/admin/emojis?status=deleted')).payload.items[0].id, uploadedId);
    const restored = await admin.json(`/api/admin/emojis/${uploadedId}/restore`, { method: 'POST' });
    assert.equal(restored.payload.emoji.deletedAt, null);
    const categories = await admin.json('/api/categories');
    const old = categories.payload.items.find((item) => item.name === '开心');
    assert.ok(old);
    const renamed = await admin.json(`/api/categories/${old.id}`, { method: 'PATCH', body: { name: '高兴' } });
    assert.equal(renamed.response.status, 200);
    assert.equal((await user.json('/api/emojis')).payload.items.find((item) => item.id === uploadedId).category, '高兴');
    const other = new Client(baseUrl);
    const registration = await other.json('/api/auth/register', { method: 'POST', body: { username: '另一个用户', password: 'Original@123' } });
    const role = await admin.json(`/api/admin/users/${registration.payload.user.id}/role`, { method: 'PATCH', body: { role: 'reviewer' } });
    assert.equal(role.response.status, 200);
    const reset = await admin.json(`/api/admin/users/${registration.payload.user.id}/password`, { method: 'POST', body: { password: 'NewPassword@123' } });
    assert.equal(reset.response.status, 200);
    assert.equal((await other.json('/api/auth/me')).response.status, 401);
    const disable = await admin.json(`/api/admin/users/${registration.payload.user.id}/status`, { method: 'PATCH', body: { disabled: true } });
    assert.equal(disable.payload.disabled, true);
    const loginWhileDisabled = await other.json('/api/auth/login', { method: 'POST', body: { username: '另一个用户', password: 'NewPassword@123' } });
    assert.equal(loginWhileDisabled.response.status, 403);
    const enable = await admin.json(`/api/admin/users/${registration.payload.user.id}/status`, { method: 'PATCH', body: { disabled: false } });
    assert.equal(enable.payload.disabled, false);
    assert.equal((await other.json('/api/auth/login', { method: 'POST', body: { username: '另一个用户', password: 'NewPassword@123' } })).response.status, 200);
  });

  await t.test('密码修改与设备列表', async () => {
    const sessions = await user.json('/api/auth/sessions');
    assert.ok(sessions.payload.items.some((item) => item.current));
    const change = await user.json('/api/auth/password', { method: 'POST', body: { currentPassword: 'UserTest@123', newPassword: 'Changed@123' } });
    assert.equal(change.response.status, 200);
    assert.equal((await user.json('/api/auth/me')).response.status, 200);
  });

  await t.test('退出后不能访问列表', async () => {
    const logout = await user.json('/api/auth/logout', { method: 'POST' });
    assert.equal(logout.response.status, 200);
    const list = await user.json('/api/emojis');
    assert.equal(list.response.status, 401);
  });
});

test('S3 兼容对象存储适配器可写入并读取文件', async (t) => {
  const objects = new Map();
  const server = http.createServer(async (req, res) => {
    assert.match(req.headers.authorization || '', /^AWS4-HMAC-SHA256 Credential=/);
    assert.match(req.url, /^\/meme-test\/[a-f0-9-]+\.png$/);
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(req.url, Buffer.concat(chunks));
    } else if (req.method === 'GET') {
      res.end(objects.get(req.url));
      return;
    } else if (req.method === 'DELETE') objects.delete(req.url);
    res.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const storageConfig = { endpoint: `http://127.0.0.1:${server.address().port}`,
    bucket: 'meme-test', region: 'us-east-1', accessKeyId: 'test-key', secretAccessKey: 'test-secret' };
  const storage = createObjectStorage(storageConfig);
  const key = '123e4567-e89b-12d3-a456-426614174000.png';
  await storage.put(key, PNG_1X1, 'image/png');
  assert.deepEqual(await storage.get(key), PNG_1X1);
  await storage.delete(key);
  assert.equal(objects.size, 0);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meme-vault-s3-test-'));
  const app = await createApp({ root: path.resolve(__dirname, '..'),
    dataDir: path.join(tempRoot, 'data'), uploadDir: path.join(tempRoot, 'uploads'),
    dbFile: path.join(tempRoot, 'data', 'test.db'), port: 0, host: '127.0.0.1',
    cookieSecure: false, seedDemoAccounts: false, objectStorage: storageConfig });
  t.after(async () => { await app.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  const address = await app.listen();
  const user = new Client(`http://127.0.0.1:${address.port}`);
  assert.equal((await user.json('/api/auth/register', { method: 'POST', body: { username: 's3test', password: 'S3Test@123' } })).response.status, 201);
  const form = new FormData();
  form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), '存储.png');
  const upload = await user.json('/api/emojis', { method: 'POST', body: form });
  assert.equal(upload.response.status, 201);
  const storedName = app.db.prepare('SELECT stored_name FROM emojis WHERE id = ?').get(upload.payload.emoji.id).stored_name;
  await fs.rm(path.join(tempRoot, 'uploads', storedName));
  const image = await user.request(upload.payload.emoji.imageUrl);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG_1X1);
});

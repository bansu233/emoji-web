'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
}

function directoryStats(directory) {
  let files = 0;
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  }
  return { files, bytes };
}

function pruneBackups(root, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = [];
  for (const name of candidates.slice(keep)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function main() {
  const config = loadConfig(process.env, { seedDemoAccounts: false });
  const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(config.root, 'backups'));
  const stamp = timestamp();
  const tempDir = path.join(backupRoot, `.${stamp}.tmp`);
  const finalDir = path.join(backupRoot, stamp);
  const databaseCopy = path.join(tempDir, 'meme-vault.db');

  fs.mkdirSync(backupRoot, { recursive: true });
  if (fs.existsSync(finalDir)) {
    throw new Error(`备份目录已存在：${finalDir}`);
  }
  fs.mkdirSync(tempDir, { recursive: false });

  let db;
  try {
    if (!fs.existsSync(config.dbFile)) {
      throw new Error(`数据库不存在：${config.dbFile}`);
    }

    db = new DatabaseSync(config.dbFile);
    db.exec('PRAGMA busy_timeout = 5000;');
    const users = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    const emojis = db.prepare('SELECT COUNT(*) AS total FROM emojis').get().total;
    const sessions = db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total;

    // VACUUM INTO creates a consistent snapshot even while WAL mode is active.
    const escapedTarget = databaseCopy.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
    db.close();
    db = null;

    fs.cpSync(config.uploadDir, path.join(tempDir, 'uploads'), {
      recursive: true,
      force: true,
    });

    const uploads = directoryStats(path.join(tempDir, 'uploads'));
    const manifest = {
      createdAt: new Date().toISOString(),
      database: 'meme-vault.db',
      databaseBytes: fs.statSync(databaseCopy).size,
      counts: { users, emojis, sessions },
      uploads,
      appVersion: require('../package.json').version,
    };
    fs.writeFileSync(
      path.join(tempDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );

    fs.renameSync(tempDir, finalDir);
    const keep = Number.parseInt(process.env.BACKUP_KEEP || '14', 10);
    const removed = pruneBackups(backupRoot, keep);

    console.log(`backup=${finalDir}`);
    console.log(`users=${users} emojis=${emojis} sessions=${sessions}`);
    console.log(`uploads=${uploads.files} files / ${uploads.bytes} bytes`);
    console.log(`pruned=${removed.length}`);
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors while reporting the original failure.
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error('备份失败:', error.message);
  process.exitCode = 1;
}

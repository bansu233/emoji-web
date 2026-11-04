'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const db = new DatabaseSync(config.dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'reviewer', 'admin')),
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS emojis (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      category       TEXT NOT NULL DEFAULT '未分类',
      stored_name    TEXT NOT NULL UNIQUE,
      original_name  TEXT NOT NULL,
      mime_type      TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      width          INTEGER NOT NULL,
      height         INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
      review_note    TEXT,
      reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at    TEXT,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emojis_status_created
      ON emojis(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_emojis_owner_created
      ON emojis(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_emojis_category
      ON emojis(category);

  `);

  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const emojiColumns = columns('emojis');
  if (!emojiColumns.has('deleted_at')) db.exec('ALTER TABLE emojis ADD COLUMN deleted_at TEXT');
  if (!emojiColumns.has('tags')) db.exec("ALTER TABLE emojis ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  if (!emojiColumns.has('thumbnail_name')) db.exec('ALTER TABLE emojis ADD COLUMN thumbnail_name TEXT');
  const sessionColumns = columns('sessions');
  if (!sessionColumns.has('user_agent')) db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT');
  if (!sessionColumns.has('ip_address')) db.exec('ALTER TABLE sessions ADD COLUMN ip_address TEXT');
  const userColumns = columns('users');
  if (!userColumns.has('disabled_at')) db.exec('ALTER TABLE users ADD COLUMN disabled_at TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji_id INTEGER NOT NULL REFERENCES emojis(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, emoji_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_emojis_deleted ON emojis(deleted_at);
    PRAGMA user_version = 2;
  `);
  db.prepare(`INSERT OR IGNORE INTO categories (name, created_at)
    SELECT DISTINCT category, ? FROM emojis WHERE category <> ''`).run(new Date().toISOString());

  return db;
}

async function seedAccounts(db, config) {
  if (!config.seedDemoAccounts) return [];
  const accounts = [
    {
      username: config.adminUsername,
      password: config.adminPassword,
      role: 'admin',
    },
  ];
  if (config.reviewerUsername && config.reviewerPassword) {
    accounts.push({
      username: config.reviewerUsername,
      password: config.reviewerPassword,
      role: 'reviewer',
    });
  }

  const created = [];
  const findUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  );

  for (const account of accounts) {
    if (!account.username || !account.password) continue;
    if (findUser.get(account.username)) continue;
    const passwordHash = await hashPassword(account.password);
    insertUser.run(account.username, passwordHash, account.role, new Date().toISOString());
    created.push({ username: account.username, role: account.role });
  }
  return created;
}

module.exports = { openDatabase, seedAccounts };

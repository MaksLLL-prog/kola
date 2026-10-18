// Один интерфейс для SQLite (по умолчанию) и Postgres (если задан DATABASE_URL).
// Запросы пишутся с именованными параметрами @name и общим SQL-подмножеством.
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const PG = !!process.env.DATABASE_URL;
const ID = PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';
const UNAME = PG ? 'TEXT NOT NULL' : 'TEXT NOT NULL UNIQUE COLLATE NOCASE';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id ${ID}, username ${UNAME}, name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', avatar TEXT, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, onboarded INTEGER NOT NULL DEFAULT 1)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))`,
  `CREATE TABLE IF NOT EXISTS posts (id ${ID}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '', image TEXT, created_at TEXT NOT NULL, repost_of INTEGER REFERENCES posts(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, PRIMARY KEY (user_id, post_id))`,
  `CREATE TABLE IF NOT EXISTS comments (id ${ID}, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, id)`,
  `CREATE TABLE IF NOT EXISTS follows (follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (follower_id, followee_id))`,
  `CREATE TABLE IF NOT EXISTS notifications (id ${ID}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, post_id INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS bookmarks (id ${ID}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at TEXT NOT NULL, UNIQUE (user_id, post_id))`,
  `CREATE INDEX IF NOT EXISTS bookmarks_user ON bookmarks (user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS post_tags (post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (post_id, tag))`,
  `CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id DESC)`,
  `CREATE TABLE IF NOT EXISTS messages (id ${ID}, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS messages_out ON messages (sender_id, recipient_id, id)`,
  `CREATE INDEX IF NOT EXISTS messages_in ON messages (recipient_id, sender_id, id)`,
];

// колонки, добавленные после версии 1.0; индексы по ним создаются после миграции
const COLUMNS = [
  ['comments', 'parent_id', 'INTEGER REFERENCES comments(id) ON DELETE CASCADE'],
  ['posts', 'repost_of', 'INTEGER REFERENCES posts(id) ON DELETE CASCADE'],
  ['users', 'onboarded', 'INTEGER NOT NULL DEFAULT 1'], // у старых аккаунтов онбординг считается пройденным
];
const AFTER = [
  'CREATE INDEX IF NOT EXISTS posts_repost ON posts (repost_of)',
  'CREATE UNIQUE INDEX IF NOT EXISTS posts_one_repost ON posts (user_id, repost_of) WHERE repost_of IS NOT NULL',
];

// @name -> ? (SQLite) или $n (Postgres)
function compile(sql, params = {}) {
  const vals = [], idx = {};
  const out = sql.replace(/@(\w+)/g, (_, k) => {
    if (!(k in params)) throw new Error('Нет параметра запроса: ' + k);
    if (PG) { if (!(k in idx)) { vals.push(params[k]); idx[k] = vals.length; } return '$' + idx[k]; }
    vals.push(params[k]); return '?';
  });
  return { sql: out, vals };
}

let impl;
if (PG) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined });
  impl = {
    all: async (s, v) => (await pool.query(s, v)).rows,
    get: async (s, v) => (await pool.query(s, v)).rows[0],
    run: async (s, v) => ({ changes: (await pool.query(s, v)).rowCount }),
    close: () => pool.end(),
    init: async () => {
      for (const s of SCHEMA) await pool.query(s);
      for (const [t, c, ddl] of COLUMNS) await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${ddl}`);
      for (const s of AFTER) await pool.query(s);
    },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const sdb = new DatabaseSync(path.join(DATA_DIR, 'kolo.db'));
  sdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // встроенный lower() в SQLite понимает только латиницу — подменяем, чтобы поиск работал и по кириллице
  sdb.function('lower', { deterministic: true }, (v) => (v == null ? null : String(v).toLowerCase()));
  const cache = new Map();
  const stmt = (s) => { let st = cache.get(s); if (!st) cache.set(s, (st = sdb.prepare(s))); return st; };
  impl = {
    all: async (s, v) => stmt(s).all(...v),
    get: async (s, v) => stmt(s).get(...v),
    run: async (s, v) => ({ changes: Number(stmt(s).run(...v).changes) }),
    close: async () => sdb.close(),
    init: async () => {
      sdb.exec(SCHEMA.join(';\n'));
      for (const [t, c, ddl] of COLUMNS)
        if (!sdb.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) sdb.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`);
      sdb.exec(AFTER.join(';\n'));
    },
  };
}

const wrap = (fn) => (sql, params) => { const c = compile(sql, params); return fn(c.sql, c.vals); };
const db = {
  kind: PG ? 'postgres' : 'sqlite',
  all: wrap(impl.all),
  get: wrap(impl.get),
  run: wrap(impl.run),
  // INSERT с возвратом id (RETURNING есть и в SQLite 3.35+, и в Postgres)
  insert: async (sql, params) => (await wrap(impl.get)(sql + ' RETURNING id', params)).id,
  init: impl.init,
  close: impl.close,
};

module.exports = { db, DATA_DIR };

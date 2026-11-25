import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

let db: DatabaseSync | null = null;
let dbPathResolved = '';

export function getDataDir(): string {
  const configuredDb = process.env.SQLITE_PATH?.trim();
  if (configuredDb) {
    return path.dirname(path.resolve(configuredDb));
  }
  const configuredDir = process.env.DATA_DIR?.trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }
  return path.resolve(process.cwd(), 'data');
}

export function getDatabasePath(): string {
  const configured = process.env.SQLITE_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(getDataDir(), 'zephyrix.db');
}

export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('SQLite database is not initialized yet.');
  }
  return db;
}

export function isDatabaseReady(): boolean {
  return db !== null;
}

export function getDatabaseStatus(): { ready: boolean; path: string } {
  return {
    ready: db !== null,
    path: dbPathResolved || getDatabasePath(),
  };
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initDatabase(): void {
  if (db) return;

  dbPathResolved = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPathResolved), { recursive: true });

  const database = new DatabaseSync(dbPathResolved);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT NOT NULL DEFAULT '',
      verified_flag INTEGER NOT NULL DEFAULT 0,
      developer_badge INTEGER NOT NULL DEFAULT 0,
      preferred_locale TEXT NOT NULL DEFAULT 'en',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL DEFAULT 'Web Browser',
      user_agent TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      country_code TEXT NOT NULL DEFAULT 'ZZ',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'channel', 'saved', 'ai')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      invite_code TEXT UNIQUE,
      zego_room_id TEXT UNIQUE,
      is_banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      muted_until TEXT,
      pinned_at TEXT,
      archived_at TEXT,
      last_read_at TEXT,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      reply_to_id TEXT REFERENCES messages(id),
      forwarded_from TEXT,
      quote_text TEXT,
      body TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_silent INTEGER NOT NULL DEFAULT 0,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
      ON messages(chat_id, sender_id, client_id)
      WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_chat_created
      ON messages(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      url TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'voice', 'document')),
      size_bytes INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS message_receipts (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivered_at TEXT,
      read_at TEXT,
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      caller_id TEXT NOT NULL REFERENCES users(id),
      call_type TEXT NOT NULL CHECK (call_type IN ('audio', 'video', 'group')),
      room_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ringing',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE,
      avatar_url TEXT,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
      api_endpoint TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      system_instruction TEXT NOT NULL DEFAULT '',
      is_verified INTEGER NOT NULL DEFAULT 1,
      assigned_chat_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS message_hidden_for (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_hidden_for_user ON message_hidden_for(user_id, message_id);
  `);

  // Safe additive checks for any pre-existing database files
  ensureColumn(database, 'users', 'phone', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'country', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'is_admin', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'users', 'is_banned', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'users', 'ban_reason', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'verified_flag', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'users', 'developer_badge', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'chats', 'avatar_url', 'TEXT');
  ensureColumn(database, 'chats', 'is_banned', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'chats', 'ban_reason', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'chats', 'assigned_bot_id', "TEXT");
  ensureColumn(database, 'attachments', 'url', "TEXT NOT NULL DEFAULT ''");

  try {
    const defaultBot = database.prepare(`SELECT id FROM bots WHERE id = 'bot_zephyrix_ai'`).get();
    if (!defaultBot) {
      database.prepare(`
        INSERT INTO bots (id, name, handle, description, provider, model, is_verified, created_at)
        VALUES ('bot_zephyrix_ai', 'Zephyrix AI Assistant', 'zephyrix_ai', 'Intelligent multimodal companion powered by Gemini', 'gemini', 'gemini-4-hydrogen', 1, datetime('now'))
      `).run();
    }
  } catch (err) {
    console.error('[sqlite] Error seeding default bot:', err);
  }

  db = database;
  console.info(`[sqlite] Database initialized at ${dbPathResolved}`);
}

export function dbGet<T = Record<string, unknown>>(sql: string, params: SQLInputValue[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function dbAll<T = Record<string, unknown>>(sql: string, params: SQLInputValue[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function dbRun(sql: string, params: SQLInputValue[] = []): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return getDb().prepare(sql).run(...params);
}

export function withTx<T>(fn: () => T): T {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    console.error('[sqlite] Error closing database:', err);
  } finally {
    db = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

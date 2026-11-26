import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import { hashPassword, verifyPassword } from './security.ts';

export type DatabaseEngine = 'postgres' | 'sqlite';
export type SqlParam = SQLInputValue | undefined;

type TxStore =
  | { engine: 'postgres'; client: PoolClient }
  | { engine: 'sqlite' };

const txContext = new AsyncLocalStorage<TxStore>();

let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let activeEngine: DatabaseEngine = 'sqlite';
let dbPathResolved = '';
let sqliteTxQueue: Promise<unknown> = Promise.resolve();

const PG_UTC_ISO_EXPR = `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

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

export function isDatabaseReady(): boolean {
  return activeEngine === 'postgres' ? pgPool !== null : sqliteDb !== null;
}

export function getDatabaseStatus(): { ready: boolean; engine: DatabaseEngine; path: string } {
  if (activeEngine === 'postgres') {
    return {
      ready: pgPool !== null,
      engine: 'postgres',
      path: 'postgresql (DATABASE_URL)',
    };
  }
  return {
    ready: sqliteDb !== null,
    engine: 'sqlite',
    path: dbPathResolved || getDatabasePath(),
  };
}

function normalizeParams(params: SqlParam[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : p));
}

export function convertSqlToPostgres(sql: string): string {
  let transformed = sql
    .replace(/\bdatetime\s*\(\s*'now'\s*\)/gi, PG_UTC_ISO_EXPR)
    .replace(/\bm\.rowid\b/gi, 'm.seq');

  // Support INSERT OR IGNORE INTO ... as fallback if ever emitted
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(transformed)) {
    transformed = transformed.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    if (!/\bON\s+CONFLICT\b/i.test(transformed)) {
      transformed = `${transformed.trim().replace(/;$/, '')} ON CONFLICT DO NOTHING`;
    }
  }

  let out = '';
  let paramIndex = 0;
  let inSingleQuote = false;

  for (let i = 0; i < transformed.length; i++) {
    const ch = transformed[i];
    if (ch === "'") {
      if (inSingleQuote && transformed[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += ch;
      continue;
    }

    if (!inSingleQuote && ch === '?') {
      paramIndex += 1;
      out += `$${paramIndex}`;
      continue;
    }

    out += ch;
  }

  return out;
}

function normalizePostgresConnection(connectionString: string): {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
} {
  try {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';

    let ssl: false | { rejectUnauthorized: boolean };
    if (sslMode === 'disable' || (isLocal && !sslMode)) {
      ssl = false;
    } else {
      ssl = { rejectUnauthorized: false };
    }

    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('uselibpqcompat');
    return { connectionString: parsed.toString(), ssl };
  } catch {
    return { connectionString, ssl: { rejectUnauthorized: false } };
  }
}

function ensureSqliteColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function seedDefaultBot(): Promise<void> {
  try {
    const defaultBot = await dbGet<{ id: string }>(`SELECT id FROM bots WHERE id = 'bot_zephyrix_ai'`);
    if (!defaultBot) {
      await dbRun(
        `INSERT INTO bots (id, name, handle, description, provider, model, is_verified, created_at)
         VALUES ('bot_zephyrix_ai', 'Zephyrix AI Assistant', 'zephyrix_ai', 'Intelligent multimodal companion powered by Gemini', 'gemini', 'gemini-4-hydrogen', 1, ?)`,
        [nowIso()]
      );
    }
  } catch (err) {
    console.error(`[${activeEngine}] Error seeding default bot:`, err);
  }
}

async function seedSuperAdminFromEnv(): Promise<void> {
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminEmail || !adminEmail.includes('@') || adminPassword.length < 6) {
      return;
    }

    const existingAdmin = await dbGet<{ id: string; is_admin: number; password_hash: string }>(
      `SELECT id, is_admin, password_hash FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [adminEmail]
    );

    if (!existingAdmin) {
      const rawBase = adminEmail.split('@')[0].replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'superadmin';
      const baseUsername = rawBase.length >= 3 ? rawBase : `${rawBase}_admin`;
      const usernameTaken = await dbGet<{ id: string }>(`SELECT id FROM users WHERE username = ? LIMIT 1`, [
        baseUsername,
      ]);
      const username = usernameTaken
        ? `${baseUsername.slice(0, 24)}_${crypto.randomBytes(3).toString('hex')}`
        : baseUsername;

      const adminId = crypto.randomUUID();
      const savedChatId = crypto.randomUUID();
      const aiChatId = crypto.randomUUID();
      const passwordHash = hashPassword(adminPassword);
      const now = nowIso();

      await withTx(async () => {
        await dbRun(
          `INSERT INTO users (id, email, password_hash, username, display_name, bio, is_admin, verified_flag, developer_badge, preferred_locale, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, 'Super Admin', 'Zephyrix Super Administrator', 1, 1, 1, 'en', ?, ?)`,
          [adminId, adminEmail, passwordHash, username, now, now]
        );

        await dbRun(
          `INSERT INTO chats (id, type, title, description, zego_room_id, created_by, created_at)
           VALUES (?, 'saved', 'Saved Messages', 'Personal cloud notes & bookmarks', ?, ?, ?)`,
          [savedChatId, `saved_${adminId.slice(0, 12)}`, adminId, now]
        );
        await dbRun(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'owner', ?, ?)`,
          [savedChatId, adminId, now, now]
        );

        await dbRun(
          `INSERT INTO chats (id, type, title, description, zego_room_id, created_by, created_at)
           VALUES (?, 'ai', 'Zephyrix AI Assistant', 'Your intelligent multimodal companion powered by Gemini', ?, ?, ?)`,
          [aiChatId, `ai_${adminId.slice(0, 12)}`, adminId, now]
        );
        await dbRun(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'owner', ?, ?)`,
          [aiChatId, adminId, now, now]
        );
      });

      console.info(`[${activeEngine}] Seeded Super Admin account for ${adminEmail}`);
    } else {
      const passwordMatches = verifyPassword(adminPassword, existingAdmin.password_hash);
      if (!existingAdmin.is_admin || !passwordMatches) {
        await withTx(async () => {
          if (!passwordMatches) {
            await dbRun(`UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?`, [
              hashPassword(adminPassword),
              existingAdmin.id,
            ]);
            await dbRun(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
              nowIso(),
              existingAdmin.id,
            ]);
          } else {
            await dbRun(`UPDATE users SET is_admin = 1 WHERE id = ?`, [existingAdmin.id]);
          }
        });
        console.info(`[${activeEngine}] Reconciled configured Super Admin account.`);
      }
    }
  } catch (err) {
    console.error(`[${activeEngine}] Error seeding Super Admin from env:`, err);
  }
}

async function initPostgres(databaseUrl: string): Promise<void> {
  if (pgPool) return;

  const pgConfig = normalizePostgresConnection(databaseUrl);
  const pool = new Pool({
    connectionString: pgConfig.connectionString,
    ssl: pgConfig.ssl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (err) => {
    console.error('[postgres] Unexpected idle client error:', err.message);
  });

  const client = await pool.connect();
  try {
    await client.query(`
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
        last_seen_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
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
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
        last_seen_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
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
        assigned_bot_id TEXT,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        joined_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
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
        seq BIGSERIAL,
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
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR})
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
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR})
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
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
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        caller_id TEXT NOT NULL REFERENCES users(id),
        call_type TEXT NOT NULL CHECK (call_type IN ('audio', 'video', 'group')),
        room_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ringing',
        started_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
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
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR})
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR})
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS message_hidden_for (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hidden_at TEXT NOT NULL DEFAULT (${PG_UTC_ISO_EXPR}),
        PRIMARY KEY (message_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_hidden_for_user ON message_hidden_for(user_id, message_id);

      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_flag INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS developer_badge INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_banned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS assigned_bot_id TEXT;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS url TEXT NOT NULL DEFAULT '';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
    `);
  } finally {
    client.release();
  }

  pgPool = pool;
  activeEngine = 'postgres';

  await seedDefaultBot();
  await seedSuperAdminFromEnv();
  console.info('[postgres] Database pool initialized via DATABASE_URL');
}

async function initSqlite(): Promise<void> {
  if (sqliteDb) return;

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
      assigned_bot_id TEXT,
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

  ensureSqliteColumn(database, 'users', 'phone', "TEXT NOT NULL DEFAULT ''");
  ensureSqliteColumn(database, 'users', 'country', "TEXT NOT NULL DEFAULT ''");
  ensureSqliteColumn(database, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'users', 'ban_reason', "TEXT NOT NULL DEFAULT ''");
  ensureSqliteColumn(database, 'users', 'verified_flag', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'users', 'developer_badge', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'chats', 'avatar_url', 'TEXT');
  ensureSqliteColumn(database, 'chats', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'chats', 'ban_reason', "TEXT NOT NULL DEFAULT ''");
  ensureSqliteColumn(database, 'chats', 'assigned_bot_id', 'TEXT');
  ensureSqliteColumn(database, 'attachments', 'url', "TEXT NOT NULL DEFAULT ''");

  sqliteDb = database;
  activeEngine = 'sqlite';

  await seedDefaultBot();
  await seedSuperAdminFromEnv();
  console.info(`[sqlite] Database initialized at ${dbPathResolved}`);
}

export async function initDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    await initPostgres(databaseUrl);
  } else {
    await initSqlite();
  }
}

function getSqliteDb(): DatabaseSync {
  if (!sqliteDb) {
    throw new Error('SQLite database is not initialized yet.');
  }
  return sqliteDb;
}

function getPgPool(): Pool {
  if (!pgPool) {
    throw new Error('PostgreSQL pool is not initialized yet.');
  }
  return pgPool;
}

export async function dbGet<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
  const normalized = normalizeParams(params);
  if (activeEngine === 'postgres') {
    const pgSql = convertSqlToPostgres(sql);
    const store = txContext.getStore();
    const runner = store?.engine === 'postgres' ? store.client : getPgPool();
    const res = await runner.query(pgSql, normalized);
    return (res.rows[0] as T | undefined) ?? undefined;
  }
  return getSqliteDb().prepare(sql).get(...normalized) as T | undefined;
}

export async function dbAll<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  const normalized = normalizeParams(params);
  if (activeEngine === 'postgres') {
    const pgSql = convertSqlToPostgres(sql);
    const store = txContext.getStore();
    const runner = store?.engine === 'postgres' ? store.client : getPgPool();
    const res = await runner.query(pgSql, normalized);
    return res.rows as T[];
  }
  return getSqliteDb().prepare(sql).all(...normalized) as T[];
}

export async function dbRun(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
  const normalized = normalizeParams(params);
  if (activeEngine === 'postgres') {
    const pgSql = convertSqlToPostgres(sql);
    const store = txContext.getStore();
    const runner = store?.engine === 'postgres' ? store.client : getPgPool();
    const res = await runner.query(pgSql, normalized);
    return { changes: res.rowCount ?? 0 };
  }
  const res = getSqliteDb().prepare(sql).run(...normalized);
  return { changes: Number(res.changes ?? 0) };
}

export async function withTx<T>(fn: () => Promise<T> | T): Promise<T> {
  const currentStore = txContext.getStore();

  if (activeEngine === 'postgres') {
    if (currentStore?.engine === 'postgres') {
      return await fn();
    }
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const result = await txContext.run({ engine: 'postgres', client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[postgres] Error rolling back transaction:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  if (currentStore?.engine === 'sqlite') {
    return await fn();
  }

  const runSerialized = async (): Promise<T> => {
    const database = getSqliteDb();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await txContext.run({ engine: 'sqlite' }, fn);
      database.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // ignore rollback failure if already rolled back
      }
      throw err;
    }
  };

  const next = sqliteTxQueue.then(runSerialized, runSerialized);
  sqliteTxQueue = next.catch(() => undefined);
  return next;
}

export async function closeDatabase(): Promise<void> {
  if (pgPool) {
    try {
      await pgPool.end();
    } catch (err) {
      console.error('[postgres] Error closing pool:', err);
    } finally {
      pgPool = null;
    }
  }
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch (err) {
      console.error('[sqlite] Error closing database:', err);
    } finally {
      sqliteDb = null;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

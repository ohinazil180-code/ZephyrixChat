import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { dbAll, dbGet, dbRun, nowIso, withTx } from './db.ts';
import {
  checkRateLimit,
  getClientIp,
  hashIp,
  hashPassword,
  hashToken,
  isValidSafeUrl,
  sendApiError,
  verifyPassword,
} from './security.ts';
import { isZegoConfigured } from './zego.ts';

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  display_name: string;
  phone: string;
  country: string;
  avatar_url: string | null;
  bio: string;
  verified_flag: boolean;
  developer_badge: boolean;
  preferred_locale: string;
  is_admin: boolean;
  is_banned: boolean;
}

export interface AuthRequest extends Request {
  authUser?: AuthenticatedUser;
  authSessionId?: string;
}

const SESSION_COOKIE_NAME = 'zephyrix_sid';

function parseDeviceLabel(ua: string): string {
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS Safari / PWA';
  if (/android/i.test(ua)) return 'Android Browser / PWA';
  if (/edg/i.test(ua)) return 'Microsoft Edge';
  if (/chrome/i.test(ua)) return 'Google Chrome';
  if (/firefox/i.test(ua)) return 'Mozilla Firefox';
  if (/safari/i.test(ua)) return 'Apple Safari';
  return 'Desktop Web Client';
}

function setSessionCookie(res: Response, rawToken: string): void {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function createServerSession(userId: string, req: Request, res: Response): { token: string; sessionId: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const sessionId = crypto.randomUUID();
  const ua = String(req.headers['user-agent'] || '').slice(0, 220);
  const deviceLabel = parseDeviceLabel(ua);
  const ipHash = hashIp(getClientIp(req));
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  dbRun(
    `INSERT INTO sessions (id, user_id, token_hash, device_label, user_agent, ip_hash, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, tokenHash, deviceLabel, ua, ipHash, now, now, expiresAt]
  );

  setSessionCookie(res, rawToken);
  return { token: rawToken, sessionId };
}

export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (cookies && cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  return null;
}

function mapUserRow(row: Record<string, unknown>): AuthenticatedUser {
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    display_name: String(row.display_name),
    phone: String(row.phone || ''),
    country: String(row.country || ''),
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    bio: String(row.bio || ''),
    verified_flag: Boolean(row.verified_flag),
    developer_badge: Boolean(row.developer_badge),
    preferred_locale: String(row.preferred_locale || 'en'),
    is_admin: Boolean(row.is_admin),
    is_banned: Boolean(row.is_banned),
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const rawToken = extractToken(req);
  if (!rawToken) {
    sendApiError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return;
  }

  try {
    const tokenHash = hashToken(rawToken);
    const now = nowIso();
    const row = dbGet<Record<string, unknown>>(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              u.id, u.email, u.username, u.display_name, u.phone, u.country,
              u.avatar_url, u.bio, u.verified_flag, u.developer_badge,
              u.preferred_locale, u.is_admin, u.is_banned, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );

    if (!row || row.revoked_at || row.deleted_at || String(row.expires_at) <= now) {
      sendApiError(res, 401, 'SESSION_INVALID', 'Session expired or signed out.');
      return;
    }

    if (Boolean(row.is_banned)) {
      sendApiError(res, 403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended or banned by an administrator.');
      return;
    }

    const sessionId = String(row.session_id);
    const userId = String(row.id);

    dbRun(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [now, sessionId]);
    dbRun(`UPDATE users SET last_seen_at = ? WHERE id = ?`, [now, userId]);

    req.authSessionId = sessionId;
    req.authUser = mapUserRow(row);
    next();
  } catch (err) {
    console.error('[auth] requireAuth error:', err instanceof Error ? err.message : 'unknown');
    sendApiError(res, 500, 'AUTH_CHECK_FAILED', 'Failed to verify session.');
  }
}

const signupSchema = z.object({
  displayName: z.string().trim().min(2, 'Full name must be at least 2 characters.').max(60),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^@/, ''))
    .pipe(z.string().regex(/^[a-z0-9_]{3,32}$/, 'Username must be 3–32 characters (a-z, 0-9, _).')),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.').max(254),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128),
  phone: z.string().trim().max(32).optional().default(''),
  country: z.string().trim().max(64).optional().default(''),
  bio: z.string().trim().max(240).optional().default(''),
  avatarUrl: z.string().trim().max(1000).nullable().optional(),
  preferredLocale: z.enum(['bn', 'en']).optional().default('en'),
});

const loginSchema = z.object({
  identifier: z.string().trim().min(2, 'Email or username is required.').max(254),
  password: z.string().min(1, 'Password is required.').max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'New password must be at least 6 characters.').max(128),
});

export function registerAuthRoutes(app: Express): void {
  app.get('/api/v1/auth/config', (_req, res) => {
    res.json({
      zegoConfigured: isZegoConfigured(),
      nodeEnv: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    });
  });

  app.get('/api/v1/auth/username-check', (req, res) => {
    const raw = String(req.query.username || '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '');
    const valid = /^[a-z0-9_]{3,32}$/.test(raw);
    if (!valid) {
      res.json({ valid: false, available: false });
      return;
    }
    const existing = dbGet<{ id: string }>(`SELECT id FROM users WHERE username = ? LIMIT 1`, [raw]);
    res.json({ valid: true, available: !existing });
  });

  app.post('/api/v1/auth/signup', (req, res) => {
    const ip = getClientIp(req);
    const limit = checkRateLimit(`signup:${ip}`, 15, 60 * 60 * 1000);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      sendApiError(res, 429, 'RATE_LIMITED', 'Too many sign-up attempts. Please try again shortly.');
      return;
    }

    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid sign-up details.');
      return;
    }

    const { displayName, username, email, password, phone, country, bio, avatarUrl, preferredLocale } = parsed.data;
    if (avatarUrl && !isValidSafeUrl(avatarUrl)) {
      sendApiError(res, 400, 'INVALID_AVATAR_URL', 'Avatar URL must be a valid media path or HTTPS URL.');
      return;
    }

    try {
      const existingEmail = dbGet<{ id: string }>(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
      if (existingEmail) {
        sendApiError(res, 409, 'EMAIL_EXISTS', 'An account with this email already exists. Please sign in.');
        return;
      }

      const existingUser = dbGet<{ id: string }>(`SELECT id FROM users WHERE username = ? LIMIT 1`, [username]);
      if (existingUser) {
        sendApiError(res, 409, 'USERNAME_TAKEN', `@${username} is already taken. Choose another username.`);
        return;
      }

      const userCountRow = dbGet<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM users`);
      const isFirstUser = Number(userCountRow?.cnt || 0) === 0;
      const isAdmin = isFirstUser ? 1 : 0;

      const userId = crypto.randomUUID();
      const passwordHash = hashPassword(password);
      const now = nowIso();
      const savedChatId = crypto.randomUUID();
      const aiChatId = crypto.randomUUID();

      withTx(() => {
        dbRun(
          `INSERT INTO users (id, email, password_hash, username, display_name, phone, country, bio, avatar_url, is_admin, preferred_locale, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            email,
            passwordHash,
            username,
            displayName,
            phone,
            country,
            bio,
            avatarUrl || null,
            isAdmin,
            preferredLocale,
            now,
            now,
          ]
        );

        // Create default Saved Messages conversation
        dbRun(
          `INSERT INTO chats (id, type, title, description, zego_room_id, created_by, created_at)
           VALUES (?, 'saved', 'Saved Messages', 'Personal cloud notes & bookmarks', ?, ?, ?)`,
          [savedChatId, `saved_${userId.slice(0, 12)}`, userId, now]
        );
        dbRun(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'owner', ?, ?)`,
          [savedChatId, userId, now, now]
        );

        // Create default Zephyrix AI Assistant conversation
        dbRun(
          `INSERT INTO chats (id, type, title, description, zego_room_id, created_by, created_at)
           VALUES (?, 'ai', 'Zephyrix AI Assistant', 'Your intelligent multimodal companion powered by Gemini', ?, ?, ?)`,
          [aiChatId, `ai_${userId.slice(0, 12)}`, userId, now]
        );
        dbRun(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'owner', ?, ?)`,
          [aiChatId, userId, now, now]
        );
      });

      const { token } = createServerSession(userId, req, res);
      const userRow = dbGet<Record<string, unknown>>(`SELECT * FROM users WHERE id = ?`, [userId]);

      res.status(201).json({
        token,
        user: userRow ? mapUserRow(userRow) : null,
      });
    } catch (err) {
      console.error('[auth] Signup failed:', err instanceof Error ? err.message : 'unknown');
      sendApiError(res, 500, 'SIGNUP_FAILED', 'Unable to create account.');
    }
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const ip = getClientIp(req);
    const limit = checkRateLimit(`login:${ip}`, 25, 15 * 60 * 1000);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      sendApiError(res, 429, 'RATE_LIMITED', 'Too many login attempts. Please wait a minute.');
      return;
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Email and password required.');
      return;
    }

    const cleanId = parsed.data.identifier.trim().toLowerCase().replace(/^@/, '');
    try {
      const userRow = dbGet<Record<string, unknown>>(
        `SELECT * FROM users WHERE (email = ? OR username = ?) AND deleted_at IS NULL LIMIT 1`,
        [cleanId, cleanId]
      );

      if (!userRow || !verifyPassword(parsed.data.password, String(userRow.password_hash || ''))) {
        sendApiError(res, 401, 'INVALID_CREDENTIALS', 'Incorrect email/username or password.');
        return;
      }

      if (Boolean(userRow.is_banned)) {
        sendApiError(res, 403, 'ACCOUNT_SUSPENDED', String(userRow.ban_reason || 'Your account has been suspended or banned.'));
        return;
      }

      const userId = String(userRow.id);
      const now = nowIso();
      dbRun(`UPDATE users SET last_seen_at = ? WHERE id = ?`, [now, userId]);

      const { token } = createServerSession(userId, req, res);
      res.json({
        token,
        user: mapUserRow(userRow),
      });
    } catch (err) {
      console.error('[auth] Login failed:', err instanceof Error ? err.message : 'unknown');
      sendApiError(res, 500, 'LOGIN_FAILED', 'Unable to sign in right now.');
    }
  });

  app.post('/api/v1/auth/password', requireAuth, (req: AuthRequest, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid password.');
      return;
    }

    const row = dbGet<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = ?`, [req.authUser!.id]);
    if (!row || !verifyPassword(parsed.data.currentPassword, row.password_hash)) {
      sendApiError(res, 401, 'WRONG_PASSWORD', 'Current password is incorrect.');
      return;
    }

    const nextHash = hashPassword(parsed.data.newPassword);
    dbRun(`UPDATE users SET password_hash = ? WHERE id = ?`, [nextHash, req.authUser!.id]);
    res.json({ ok: true });
  });

  app.post('/api/v1/auth/logout', requireAuth, (req: AuthRequest, res) => {
    dbRun(`UPDATE sessions SET revoked_at = ? WHERE id = ?`, [nowIso(), req.authSessionId!]);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/',
    });
    res.json({ ok: true });
  });

  app.get('/api/v1/auth/sessions', requireAuth, (req: AuthRequest, res) => {
    const rows = dbAll<Record<string, unknown>>(
      `SELECT id, device_label, user_agent, country_code, created_at, last_seen_at, expires_at
       FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC`,
      [req.authUser!.id, nowIso()]
    );
    res.json({
      sessions: rows.map((r) => ({
        id: String(r.id),
        device_label: String(r.device_label),
        user_agent: String(r.user_agent),
        country_code: String(r.country_code),
        created_at: String(r.created_at),
        last_seen_at: String(r.last_seen_at),
        expires_at: String(r.expires_at),
        isCurrent: String(r.id) === req.authSessionId,
      })),
    });
  });

  app.delete('/api/v1/auth/sessions/:sessionId', requireAuth, (req: AuthRequest, res) => {
    const result = dbRun(
      `UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      [nowIso(), String(req.params.sessionId), req.authUser!.id]
    );
    if (result.changes === 0) {
      sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Session not found.');
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/v1/auth/sessions/revoke-others', requireAuth, (req: AuthRequest, res) => {
    dbRun(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
      [nowIso(), req.authUser!.id, req.authSessionId!]
    );
    res.json({ ok: true });
  });
}

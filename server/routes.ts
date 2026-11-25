import crypto from 'node:crypto';
import type { Express, Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from './auth.ts';
import { dbAll, dbGet, dbRun, getDatabaseStatus, nowIso, withTx } from './db.ts';
import {
  addEventStream,
  isUserConnectedSse,
  publishReactionToChat,
  publishToChat,
  publishToUsers,
  removeEventStream,
} from './events.ts';
import { isSafeExternalHttpUrl, isValidSafeUrl, sendApiError } from './security.ts';
import { generateToken04, getZegoCredentials } from './zego.ts';
import { GoogleGenAI } from '@google/genai';

function recordAuditLog(adminId: string, action: string, targetId: string, details: string): void {
  try {
    dbRun(
      `INSERT INTO audit_logs (id, admin_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), adminId, action, targetId, details, nowIso()]
    );
  } catch (err) {
    console.error('[audit] failed to record audit log:', err);
  }
}

function normalizeAttachmentsForHydration(rows: Record<string, unknown>[]) {
  return rows.map((a) => ({
    id: String(a.id),
    storageKey: String(a.storage_key),
    url: String(a.url || `/api/v1/media/file/${a.storage_key}`),
    originalName: String(a.original_name),
    mimeType: String(a.mime_type),
    kind: String(a.kind) as 'image' | 'video' | 'voice' | 'document',
    sizeBytes: Number(a.size_bytes),
    durationMs: Number(a.duration_ms || 0),
    checksum: String(a.checksum || ''),
  }));
}

function hydrateMessages(rows: Record<string, unknown>[], viewerId?: string) {
  if (rows.length === 0) return [];
  const msgIds = rows.map((r) => String(r.id));
  const placeholders = msgIds.map(() => '?').join(', ');

  const attRows = dbAll<Record<string, unknown>>(
    `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
    msgIds
  );
  const attsByMsg = new Map<string, ReturnType<typeof normalizeAttachmentsForHydration>>();
  for (const att of attRows) {
    const mid = String(att.message_id);
    const list = attsByMsg.get(mid) || [];
    list.push(...normalizeAttachmentsForHydration([att]));
    attsByMsg.set(mid, list);
  }

  const reactRows = dbAll<{ message_id: string; emoji: string; user_id: string; display_name: string }>(
    `SELECT r.message_id, r.emoji, r.user_id, u.display_name
     FROM reactions r
     JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (${placeholders})
     ORDER BY r.created_at ASC`,
    msgIds
  );
  const reactionsByMsg = new Map<
    string,
    Array<{
      emoji: string;
      count: number;
      reactedByMe: boolean;
      users: Array<{ id: string; displayName: string }>;
    }>
  >();
  const tmpReact = new Map<string, Map<string, Map<string, string>>>();
  for (const r of reactRows) {
    let byEmoji = tmpReact.get(r.message_id);
    if (!byEmoji) {
      byEmoji = new Map();
      tmpReact.set(r.message_id, byEmoji);
    }
    let usersMap = byEmoji.get(r.emoji);
    if (!usersMap) {
      usersMap = new Map();
      byEmoji.set(r.emoji, usersMap);
    }
    usersMap.set(String(r.user_id), String(r.display_name || 'User'));
  }
  for (const [mid, byEmoji] of tmpReact.entries()) {
    reactionsByMsg.set(
      mid,
      Array.from(byEmoji.entries()).map(([emoji, usersMap]) => ({
        emoji,
        count: usersMap.size,
        reactedByMe: viewerId ? usersMap.has(viewerId) : false,
        users: Array.from(usersMap.entries()).map(([id, displayName]) => ({ id, displayName })),
      }))
    );
  }

  const receiptRows = dbAll<{ message_id: string; user_id: string; delivered_at: string | null; read_at: string | null }>(
    `SELECT message_id, user_id, delivered_at, read_at FROM message_receipts WHERE message_id IN (${placeholders})`,
    msgIds
  );
  const receiptsByMsg = new Map<string, typeof receiptRows>();
  for (const r of receiptRows) {
    const list = receiptsByMsg.get(r.message_id) || [];
    list.push(r);
    receiptsByMsg.set(r.message_id, list);
  }

  // Reply previews
  const replyIds = Array.from(new Set(rows.map((r) => (r.reply_to_id ? String(r.reply_to_id) : null)).filter(Boolean) as string[]));
  const replyMap = new Map<
    string,
    {
      id: string;
      senderName: string;
      body: string;
      deletedAt: string | null;
      attachmentName: string | null;
      attachmentKind: 'image' | 'video' | 'voice' | 'document' | null;
    }
  >();
  if (replyIds.length > 0) {
    const replyPlaceholders = replyIds.map(() => '?').join(', ');
    const rRows = dbAll<Record<string, unknown>>(
      `SELECT m.id, m.body, m.deleted_at, u.display_name AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id IN (${replyPlaceholders})`,
      replyIds
    );
    const replyAttRows = dbAll<Record<string, unknown>>(
      `SELECT message_id, original_name, kind
       FROM attachments
       WHERE message_id IN (${replyPlaceholders})
       ORDER BY created_at ASC`,
      replyIds
    );
    const firstAttByReply = new Map<string, { originalName: string; kind: 'image' | 'video' | 'voice' | 'document' }>();
    for (const ar of replyAttRows) {
      const mid = String(ar.message_id);
      if (!firstAttByReply.has(mid)) {
        firstAttByReply.set(mid, {
          originalName: String(ar.original_name || ''),
          kind: String(ar.kind) as 'image' | 'video' | 'voice' | 'document',
        });
      }
    }
    for (const rr of rRows) {
      const rid = String(rr.id);
      const isDeleted = Boolean(rr.deleted_at);
      const firstAtt = isDeleted ? undefined : firstAttByReply.get(rid);
      replyMap.set(rid, {
        id: rid,
        senderName: String(rr.sender_name || ''),
        body: isDeleted ? '' : String(rr.body || ''),
        deletedAt: rr.deleted_at ? String(rr.deleted_at) : null,
        attachmentName: firstAtt?.originalName || null,
        attachmentKind: firstAtt?.kind || null,
      });
    }
  }

  return rows.map((row) => {
    const id = String(row.id);
    const senderId = String(row.sender_id);
    const isDeletedAll = Boolean(row.deleted_at);
    const receipts = receiptsByMsg.get(id) || [];
    const replyToId = row.reply_to_id ? String(row.reply_to_id) : null;

    return {
      id,
      clientId: row.client_id ? String(row.client_id) : null,
      chatId: String(row.chat_id),
      senderId,
      senderName: String(row.sender_name || ''),
      senderUsername: row.sender_username ? String(row.sender_username) : null,
      senderAvatar: row.sender_avatar ? String(row.sender_avatar) : null,
      senderVerified: Boolean(row.sender_verified),
      senderDeveloperBadge: Boolean(row.sender_developer_badge),
      isBot: Boolean(row.is_bot) || String(senderId).startsWith('bot_'),
      replyToId,
      replyTo: replyToId ? replyMap.get(replyToId) || null : null,
      forwardedFrom: row.forwarded_from ? String(row.forwarded_from) : null,
      quoteText: row.quote_text ? String(row.quote_text) : null,
      body: isDeletedAll ? '' : String(row.body || ''),
      isPinned: Boolean(row.is_pinned),
      isSilent: Boolean(row.is_silent),
      editedAt: row.edited_at ? String(row.edited_at) : null,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      createdAt: String(row.created_at),
      attachments: isDeletedAll ? [] : attsByMsg.get(id) || [],
      reactions: isDeletedAll ? [] : reactionsByMsg.get(id) || [],
      status: receipts.some((r) => r.read_at)
        ? ('read' as const)
        : receipts.some((r) => r.delivered_at)
          ? ('delivered' as const)
          : ('sent' as const),
    };
  });
}

function getChatSummariesForUser(userId: string) {
  const chats = dbAll<Record<string, unknown>>(
    `SELECT c.id, c.type, c.title, c.description, c.avatar_url, c.invite_code, c.zego_room_id, c.assigned_bot_id,
            c.created_by, c.created_at,
            b.name AS assigned_bot_name, b.is_verified AS assigned_bot_verified,
            cm.role AS my_role, cm.pinned_at, cm.archived_at, cm.muted_until, cm.last_read_at
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id
     LEFT JOIN bots b ON b.id = c.assigned_bot_id
     WHERE cm.user_id = ?
       AND cm.left_at IS NULL
       AND c.deleted_at IS NULL
     ORDER BY c.created_at DESC`,
    [userId]
  );

  const summaries = [];
  for (const chat of chats) {
    const chatId = String(chat.id);
    const type = String(chat.type) as 'direct' | 'group' | 'channel' | 'saved' | 'ai';

    let title = String(chat.title || '');
    let avatarUrl = chat.avatar_url ? String(chat.avatar_url) : null;
    let peer: {
      id: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
      bio: string;
      phone: string;
      country: string;
      verified: boolean;
      developerBadge?: boolean;
      isBot?: boolean;
      online: boolean;
      lastSeenAt: string;
    } | null = null;
    let isBlockedByMe = false;
    let hasBlockedMe = false;

    if (type === 'direct') {
      const other = dbGet<Record<string, unknown>>(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.phone, u.country, u.verified_flag, u.developer_badge, u.last_seen_at
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = ? AND cm.user_id != ? AND cm.left_at IS NULL AND u.deleted_at IS NULL
         LIMIT 1`,
        [chatId, userId]
      );
      if (!other) continue;

      const peerId = String(other.id);
      const lastSeenMs = other.last_seen_at ? new Date(String(other.last_seen_at)).getTime() : 0;
      const isOnline = isUserConnectedSse(peerId) || Date.now() - lastSeenMs < 2 * 60 * 1000;

      const blockRows = dbAll<{ blocker_id: string; blocked_id: string }>(
        `SELECT blocker_id, blocked_id FROM blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [userId, peerId, peerId, userId]
      );
      isBlockedByMe = blockRows.some((b) => b.blocker_id === userId && b.blocked_id === peerId);
      hasBlockedMe = blockRows.some((b) => b.blocker_id === peerId && b.blocked_id === userId);

      title = String(other.display_name);
      avatarUrl = other.avatar_url ? String(other.avatar_url) : null;
      peer = {
        id: peerId,
        username: String(other.username || ''),
        displayName: title,
        avatarUrl,
        bio: String(other.bio || ''),
        phone: String(other.phone || ''),
        country: String(other.country || ''),
        verified: Boolean(other.verified_flag),
        developerBadge: Boolean(other.developer_badge),
        isBot: peerId.startsWith('bot_'),
        online: isOnline,
        lastSeenAt: String(other.last_seen_at || nowIso()),
      };
    } else if (type === 'ai') {
      peer = {
        id: 'bot_zephyrix_ai',
        username: 'zephyrix_ai',
        displayName: 'Zephyrix AI Assistant',
        avatarUrl: null,
        bio: 'Intelligent multimodal assistant powered by Gemini',
        phone: '',
        country: '',
        verified: true,
        developerBadge: false,
        isBot: true,
        online: true,
        lastSeenAt: nowIso(),
      };
    }

    const memberCountRow = dbGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM chat_members WHERE chat_id = ? AND left_at IS NULL`,
      [chatId]
    );

    const lastMsgRow = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_hidden_for mh
           WHERE mh.message_id = m.id AND mh.user_id = ?
         )
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT 1`,
      [chatId, userId]
    );

    const lastReadAt = chat.last_read_at ? String(chat.last_read_at) : null;
    const unreadRow = lastReadAt
      ? dbGet<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM messages m
           WHERE m.chat_id = ? AND m.sender_id != ? AND m.deleted_at IS NULL AND m.created_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM message_hidden_for mh
               WHERE mh.message_id = m.id AND mh.user_id = ?
             )`,
          [chatId, userId, lastReadAt, userId]
        )
      : dbGet<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM messages m
           WHERE m.chat_id = ? AND m.sender_id != ? AND m.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM message_hidden_for mh
               WHERE mh.message_id = m.id AND mh.user_id = ?
             )`,
          [chatId, userId, userId]
        );

    const hydratedLast = lastMsgRow ? hydrateMessages([lastMsgRow], userId)[0] : null;

    summaries.push({
      id: chatId,
      type,
      title,
      description: String(chat.description || ''),
      avatarUrl,
      inviteCode: chat.invite_code ? String(chat.invite_code) : null,
      zegoRoomId: chat.zego_room_id ? String(chat.zego_room_id) : `room_${chatId.slice(0, 12)}`,
      myRole: String(chat.my_role || 'member') as 'owner' | 'admin' | 'member',
      memberCount: Number(memberCountRow?.cnt || 1),
      pinnedAt: chat.pinned_at ? String(chat.pinned_at) : null,
      archivedAt: chat.archived_at ? String(chat.archived_at) : null,
      mutedUntil: chat.muted_until ? String(chat.muted_until) : null,
      createdAt: String(chat.created_at),
      peer,
      isBlockedByMe,
      hasBlockedMe,
      unreadCount: Number(unreadRow?.cnt || 0),
      lastMessage: hydratedLast,
      assignedBotId: chat.assigned_bot_id ? String(chat.assigned_bot_id) : (type === 'ai' ? 'bot_zephyrix_ai' : null),
      assignedBotName: chat.assigned_bot_name
        ? String(chat.assigned_bot_name)
        : type === 'ai'
          ? 'Zephyrix AI Assistant'
          : null,
      isBotVerified: chat.assigned_bot_id
        ? Boolean(chat.assigned_bot_verified)
        : type === 'ai',
    });
  }

  summaries.sort((a, b) => {
    if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) {
      return a.pinnedAt ? -1 : 1;
    }
    if (a.pinnedAt && b.pinnedAt) {
      const pDiff = new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime();
      if (pDiff !== 0) return pDiff;
    }
    const tA = new Date(a.lastMessage?.createdAt || a.createdAt).getTime();
    const tB = new Date(b.lastMessage?.createdAt || b.createdAt).getTime();
    return tB - tA;
  });

  return summaries;
}

function getMembership(chatId: string, userId: string) {
  return dbGet<{ role: 'owner' | 'admin' | 'member'; left_at: string | null }>(
    `SELECT role, left_at FROM chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1`,
    [chatId, userId]
  );
}

export function registerApiRoutes(app: Express): void {
  // Health Check
  app.get('/api/v1/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'zephyrix-api',
      version: '2.0.0',
      database: getDatabaseStatus(),
      zegoConfigured: getZegoCredentials() !== null,
      timestamp: nowIso(),
    });
  });

  // Real-time SSE Event Stream (uses HttpOnly session cookie or Bearer header)
  app.get('/api/v1/events', requireAuth, (req: AuthRequest, res: Response) => {
    const userId = req.authUser!.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    addEventStream(userId, res);
    res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // handled on close
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      removeEventStream(userId, res);
    });
  });

  // Profile & Account
  app.get('/api/v1/me', requireAuth, (req: AuthRequest, res) => {
    res.json({ user: req.authUser });
  });

  const updateMeSchema = z.object({
    displayName: z.string().trim().min(1).max(60).optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .transform((v) => v.replace(/^@/, ''))
      .pipe(z.string().regex(/^[a-z0-9_]{3,32}$/, 'Username must be 3–32 characters (a-z, 0-9, _).'))
      .optional(),
    phone: z.string().trim().max(32).optional(),
    country: z.string().trim().max(64).optional(),
    bio: z.string().trim().max(240).optional(),
    avatarUrl: z.string().trim().max(1000).nullable().optional(),
    preferredLocale: z.enum(['bn', 'en']).optional(),
  });

  app.patch('/api/v1/me', requireAuth, (req: AuthRequest, res) => {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid profile data.');
      return;
    }

    const userId = req.authUser!.id;
    const { displayName, username, phone, country, bio, avatarUrl, preferredLocale } = parsed.data;

    if (avatarUrl && !isValidSafeUrl(avatarUrl)) {
      sendApiError(res, 400, 'INVALID_AVATAR_URL', 'Avatar URL must be a valid uploaded media path or HTTPS URL.');
      return;
    }

    if (username) {
      const taken = dbGet<{ id: string }>(`SELECT id FROM users WHERE username = ? AND id != ?`, [username, userId]);
      if (taken) {
        sendApiError(res, 409, 'USERNAME_TAKEN', `@${username} is already taken.`);
        return;
      }
    }

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(displayName);
    }
    if (username !== undefined) {
      updates.push('username = ?');
      params.push(username);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone);
    }
    if (country !== undefined) {
      updates.push('country = ?');
      params.push(country);
    }
    if (bio !== undefined) {
      updates.push('bio = ?');
      params.push(bio);
    }
    if (avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      params.push(avatarUrl);
    }
    if (preferredLocale !== undefined) {
      updates.push('preferred_locale = ?');
      params.push(preferredLocale);
    }

    if (updates.length > 0) {
      params.push(userId);
      dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const updated = dbGet<Record<string, unknown>>(`SELECT * FROM users WHERE id = ?`, [userId]);
    res.json({
      user: updated
        ? {
            id: String(updated.id),
            email: String(updated.email),
            username: String(updated.username),
            display_name: String(updated.display_name),
            phone: String(updated.phone || ''),
            country: String(updated.country || ''),
            avatar_url: updated.avatar_url ? String(updated.avatar_url) : null,
            bio: String(updated.bio || ''),
            verified_flag: Boolean(updated.verified_flag),
            developer_badge: Boolean(updated.developer_badge),
            preferred_locale: String(updated.preferred_locale || 'en'),
          }
        : req.authUser,
    });
  });

  app.get('/api/v1/me/export', requireAuth, (req: AuthRequest, res) => {
    const userId = req.authUser!.id;
    const profile = dbGet<Record<string, unknown>>(
      `SELECT id, email, username, display_name, phone, country, bio, preferred_locale, created_at FROM users WHERE id = ?`,
      [userId]
    );
    const chats = getChatSummariesForUser(userId);
    const messages = dbAll<Record<string, unknown>>(
      `SELECT id, chat_id, body, created_at FROM messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1000`,
      [userId]
    );
    res.setHeader('Content-Disposition', 'attachment; filename="zephyrix-account-export.json"');
    res.json({
      exportedAt: nowIso(),
      profile,
      chats,
      sentMessages: messages,
    });
  });

  app.delete('/api/v1/me', requireAuth, (req: AuthRequest, res) => {
    const userId = req.authUser!.id;
    const deletedAt = nowIso();
    withTx(() => {
      dbRun(
        `UPDATE users
         SET deleted_at = ?, username = ?, email = ?, display_name = 'Deleted User', bio = '', phone = '', avatar_url = NULL
         WHERE id = ?`,
        [deletedAt, `deleted_${userId.slice(0, 8)}`, `deleted_${userId}@zephyrix.local`, userId]
      );
      dbRun(`UPDATE sessions SET revoked_at = ? WHERE user_id = ?`, [deletedAt, userId]);
    });
    res.clearCookie('zephyrix_sid', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/',
    });
    res.json({ ok: true });
  });

  // User Search & Contacts
  app.get('/api/v1/users/search', requireAuth, (req: AuthRequest, res) => {
    const q = String(req.query.q || '').trim().replace(/^@/, '').toLowerCase();
    const userId = req.authUser!.id;

    const rows = q
      ? dbAll<Record<string, unknown>>(
          `SELECT id, username, display_name, avatar_url, bio, phone, country, verified_flag, developer_badge, last_seen_at
           FROM users
           WHERE deleted_at IS NULL AND id != ?
             AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?)
           ORDER BY last_seen_at DESC
           LIMIT 30`,
          [userId, `%${q}%`, `%${q}%`]
        )
      : dbAll<Record<string, unknown>>(
          `SELECT id, username, display_name, avatar_url, bio, phone, country, verified_flag, developer_badge, last_seen_at
           FROM users
           WHERE deleted_at IS NULL AND id != ?
           ORDER BY last_seen_at DESC
           LIMIT 30`,
          [userId]
        );

    res.json({
      users: rows.map((u) => {
        const uid = String(u.id);
        const lastSeenMs = u.last_seen_at ? new Date(String(u.last_seen_at)).getTime() : 0;
        return {
          id: uid,
          username: String(u.username || ''),
          displayName: String(u.display_name),
          avatarUrl: u.avatar_url ? String(u.avatar_url) : null,
          bio: String(u.bio || ''),
          phone: String(u.phone || ''),
          country: String(u.country || ''),
          verified: Boolean(u.verified_flag),
          developerBadge: Boolean(u.developer_badge),
          online: isUserConnectedSse(uid) || Date.now() - lastSeenMs < 2 * 60 * 1000,
          lastSeenAt: String(u.last_seen_at || nowIso()),
        };
      }),
    });
  });

  // Blocking
  app.get('/api/v1/blocks', requireAuth, (req: AuthRequest, res) => {
    const rows = dbAll<Record<string, unknown>>(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, b.created_at
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ?`,
      [req.authUser!.id]
    );
    res.json({
      blocks: rows.map((r) => ({
        id: String(r.id),
        username: String(r.username || ''),
        display_name: String(r.display_name),
        avatar_url: r.avatar_url ? String(r.avatar_url) : null,
        created_at: String(r.created_at),
      })),
    });
  });

  app.post('/api/v1/blocks', requireAuth, (req: AuthRequest, res) => {
    const userId = String((req.body as { userId?: string })?.userId || '').trim();
    if (!userId || userId === req.authUser!.id) {
      sendApiError(res, 400, 'INVALID_USER', 'Cannot block this user.');
      return;
    }
    dbRun(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`, [
      req.authUser!.id,
      userId,
      nowIso(),
    ]);
    res.json({ ok: true });
  });

  app.delete('/api/v1/blocks/:targetId', requireAuth, (req: AuthRequest, res) => {
    dbRun(`DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?`, [
      req.authUser!.id,
      String(req.params.targetId),
    ]);
    res.json({ ok: true });
  });

  // Chats (Direct, Group, Channel, Saved)
  app.get('/api/v1/chats', requireAuth, (req: AuthRequest, res) => {
    res.json({ chats: getChatSummariesForUser(req.authUser!.id) });
  });

  const createChatSchema = z.object({
    type: z.enum(['direct', 'group', 'channel']),
    targetUserId: z.string().optional(),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(240).optional(),
    memberIds: z.array(z.string()).optional(),
  });

  app.post('/api/v1/chats', requireAuth, (req: AuthRequest, res) => {
    const parsed = createChatSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid chat request.');
      return;
    }

    const userId = req.authUser!.id;
    const { type, targetUserId, title, description, memberIds } = parsed.data;
    const now = nowIso();

    if (type === 'direct') {
      if (!targetUserId || targetUserId === userId) {
        sendApiError(res, 400, 'INVALID_TARGET', 'Select another user to start a direct chat.');
        return;
      }
      const targetUser = dbGet<{ id: string }>(
        `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
        [targetUserId]
      );
      if (!targetUser) {
        sendApiError(res, 404, 'USER_NOT_FOUND', 'Target user not found.');
        return;
      }

      const existing = dbGet<{ id: string }>(
        `SELECT c.id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ? AND m1.left_at IS NULL
         JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ? AND m2.left_at IS NULL
         WHERE c.type = 'direct' AND c.deleted_at IS NULL
         LIMIT 1`,
        [userId, targetUserId]
      );

      let chatId = existing?.id;
      if (!chatId) {
        chatId = crypto.randomUUID();
        const pairIds = [userId, targetUserId].sort();
        const zegoRoomId = `dm_${pairIds[0].slice(0, 8)}_${pairIds[1].slice(0, 8)}`;
        withTx(() => {
          dbRun(
            `INSERT INTO chats (id, type, title, zego_room_id, created_by, created_at)
             VALUES (?, 'direct', '', ?, ?, ?)`,
            [chatId!, zegoRoomId, userId, now]
          );
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            chatId!,
            userId,
            now,
          ]);
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            chatId!,
            targetUserId,
            now,
          ]);
        });
        publishToUsers([targetUserId], { type: 'chat:updated', chatId });
      }

      const summary = getChatSummariesForUser(userId).find((c) => c.id === chatId);
      res.status(existing ? 200 : 201).json({ chat: summary });
      return;
    }

    // Group or Channel
    if (!title) {
      sendApiError(res, 400, 'MISSING_TITLE', 'Please enter a name for the group or channel.');
      return;
    }

    const chatId = crypto.randomUUID();
    const inviteCode = crypto.randomBytes(5).toString('hex');
    const zegoRoomId = `${type}_${chatId.slice(0, 12)}`;
    const extraMembers = Array.from(new Set((memberIds || []).filter((id) => id && id !== userId)));

    withTx(() => {
      dbRun(
        `INSERT INTO chats (id, type, title, description, invite_code, zego_room_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [chatId, type, title, description || '', inviteCode, zegoRoomId, userId, now]
      );
      dbRun(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
         VALUES (?, ?, 'owner', ?, ?)`,
        [chatId, userId, now, now]
      );
      for (const mid of extraMembers) {
        const exists = dbGet<{ id: string }>(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [mid]);
        if (exists) {
          dbRun(
            `INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at)
             VALUES (?, ?, 'member', ?)`,
            [chatId, mid, now]
          );
        }
      }
    });

    if (extraMembers.length > 0) {
      publishToUsers(extraMembers, { type: 'chat:updated', chatId });
    }

    const summary = getChatSummariesForUser(userId).find((c) => c.id === chatId);
    res.status(201).json({ chat: summary });
  });

  app.post('/api/v1/chats/join', requireAuth, (req: AuthRequest, res) => {
    const inviteCode = String((req.body as { inviteCode?: string })?.inviteCode || '')
      .trim()
      .toLowerCase();
    if (!inviteCode) {
      sendApiError(res, 400, 'INVALID_INVITE', 'Invite code is required.');
      return;
    }

    const chat = dbGet<{ id: string }>(
      `SELECT id FROM chats WHERE LOWER(invite_code) = ? AND deleted_at IS NULL AND type IN ('group', 'channel') LIMIT 1`,
      [inviteCode]
    );
    if (!chat) {
      sendApiError(res, 404, 'INVITE_NOT_FOUND', 'No group or channel matched that invite code.');
      return;
    }

    const now = nowIso();
    dbRun(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at, left_at)
       VALUES (?, ?, 'member', ?, NULL)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET left_at = NULL`,
      [chat.id, req.authUser!.id, now]
    );

    publishToChat(chat.id, { type: 'chat:updated', chatId: chat.id });
    const summary = getChatSummariesForUser(req.authUser!.id).find((c) => c.id === chat.id);
    res.json({ chat: summary });
  });

  app.get('/api/v1/chats/:id', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    const summary = getChatSummariesForUser(req.authUser!.id).find((c) => c.id === chatId);
    if (!summary) {
      sendApiError(res, 404, 'CHAT_NOT_FOUND', 'Conversation not found.');
      return;
    }

    const members = dbAll<Record<string, unknown>>(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.verified_flag, u.developer_badge, u.last_seen_at,
              cm.role, cm.joined_at
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ? AND cm.left_at IS NULL AND u.deleted_at IS NULL
       ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at ASC`,
      [chatId]
    ).map((m) => {
      const uid = String(m.id);
      const lastSeenMs = m.last_seen_at ? new Date(String(m.last_seen_at)).getTime() : 0;
      return {
        id: uid,
        username: String(m.username || ''),
        displayName: String(m.display_name),
        avatarUrl: m.avatar_url ? String(m.avatar_url) : null,
        bio: String(m.bio || ''),
        verified: Boolean(m.verified_flag),
        developerBadge: Boolean(m.developer_badge),
        online: isUserConnectedSse(uid) || Date.now() - lastSeenMs < 2 * 60 * 1000,
        role: String(m.role) as 'owner' | 'admin' | 'member',
        joinedAt: String(m.joined_at),
      };
    });

    res.json({ chat: summary, members });
  });

  app.patch('/api/v1/chats/:id', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at || (membership.role !== 'owner' && membership.role !== 'admin')) {
      sendApiError(res, 403, 'FORBIDDEN', 'Only owners and admins can edit this conversation.');
      return;
    }

    const body = req.body as { title?: string; description?: string; avatarUrl?: string | null };
    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (typeof body.title === 'string' && body.title.trim()) {
      updates.push('title = ?');
      params.push(body.title.trim().slice(0, 80));
    }
    if (typeof body.description === 'string') {
      updates.push('description = ?');
      params.push(body.description.trim().slice(0, 240));
    }
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl && !isValidSafeUrl(body.avatarUrl)) {
        sendApiError(res, 400, 'INVALID_AVATAR_URL', 'Invalid avatar URL.');
        return;
      }
      updates.push('avatar_url = ?');
      params.push(body.avatarUrl);
    }

    if (updates.length > 0) {
      params.push(chatId);
      dbRun(`UPDATE chats SET ${updates.join(', ')} WHERE id = ?`, params);
      publishToChat(chatId, { type: 'chat:updated', chatId });
    }
    res.json({ ok: true });
  });

  app.post('/api/v1/chats/:id/members', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at || (membership.role !== 'owner' && membership.role !== 'admin')) {
      sendApiError(res, 403, 'FORBIDDEN', 'Only admins can add members.');
      return;
    }

    const targetUserId = String((req.body as { userId?: string })?.userId || '').trim();
    const target = dbGet<{ id: string }>(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [targetUserId]);
    if (!target) {
      sendApiError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      return;
    }

    const now = nowIso();
    dbRun(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at, left_at)
       VALUES (?, ?, 'member', ?, NULL)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET left_at = NULL`,
      [chatId, targetUserId, now]
    );
    publishToChat(chatId, { type: 'chat:updated', chatId });
    res.json({ ok: true });
  });

  app.patch('/api/v1/chats/:id/members/:targetId', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at || membership.role !== 'owner') {
      sendApiError(res, 403, 'FORBIDDEN', 'Only the owner can change member roles.');
      return;
    }
    const nextRole = (req.body as { role?: string })?.role === 'admin' ? 'admin' : 'member';
    dbRun(`UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ? AND role != 'owner'`, [
      nextRole,
      chatId,
      String(req.params.targetId),
    ]);
    publishToChat(chatId, { type: 'chat:updated', chatId });
    res.json({ ok: true });
  });

  app.delete('/api/v1/chats/:id/members/:targetId', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const targetId = String(req.params.targetId);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }

    const isSelf = targetId === req.authUser!.id;
    const isAdmin = membership.role === 'owner' || membership.role === 'admin';
    if (!isSelf && !isAdmin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Only admins can remove other members.');
      return;
    }

    dbRun(`UPDATE chat_members SET left_at = ? WHERE chat_id = ? AND user_id = ?`, [nowIso(), chatId, targetId]);
    publishToChat(chatId, { type: 'chat:updated', chatId });
    publishToUsers([targetId], { type: 'chat:updated', chatId });
    res.json({ ok: true });
  });

  app.patch('/api/v1/chats/:id/preferences', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const userId = req.authUser!.id;
    const membership = getMembership(chatId, userId);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    const body = req.body as { pinned?: boolean; archived?: boolean; muted?: boolean };
    const now = nowIso();
    if (typeof body.pinned === 'boolean') {
      dbRun(`UPDATE chat_members SET pinned_at = ? WHERE chat_id = ? AND user_id = ?`, [
        body.pinned ? now : null,
        chatId,
        userId,
      ]);
    }
    if (typeof body.archived === 'boolean') {
      dbRun(`UPDATE chat_members SET archived_at = ? WHERE chat_id = ? AND user_id = ?`, [
        body.archived ? now : null,
        chatId,
        userId,
      ]);
    }
    if (typeof body.muted === 'boolean') {
      const muteUntil = body.muted ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null;
      dbRun(`UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?`, [
        muteUntil,
        chatId,
        userId,
      ]);
    }

    const updated = dbGet<{ pinned_at: string | null; archived_at: string | null; muted_until: string | null }>(
      `SELECT pinned_at, archived_at, muted_until FROM chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1`,
      [chatId, userId]
    );

    publishToUsers([userId], { type: 'chat:updated', chatId });
    res.json({
      ok: true,
      pinnedAt: updated?.pinned_at ?? null,
      archivedAt: updated?.archived_at ?? null,
      mutedUntil: updated?.muted_until ?? null,
    });
  });

  app.post('/api/v1/chats/:id/typing', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }
    const isTyping = Boolean((req.body as { isTyping?: boolean })?.isTyping);
    publishToChat(chatId, { type: 'typing', chatId, userId: req.authUser!.id, isTyping }, req.authUser!.id);
    res.json({ ok: true });
  });

  app.post('/api/v1/chats/:id/read', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const userId = req.authUser!.id;
    const membership = getMembership(chatId, userId);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }
    const now = nowIso();

    dbRun(`UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?`, [now, chatId, userId]);
    dbRun(
      `INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
       SELECT id, ?, ?, ? FROM messages WHERE chat_id = ? AND sender_id != ?
       ON CONFLICT(message_id, user_id) DO UPDATE SET read_at = COALESCE(read_at, ?)`,
      [userId, now, now, chatId, userId, now]
    );

    publishToChat(chatId, { type: 'read', chatId, userId, readAt: now }, userId);
    res.json({ ok: true });
  });

  // Messages & Actions
  app.get('/api/v1/chats/:id/messages', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 150);
    const rows = dbAll<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_hidden_for mh
           WHERE mh.message_id = m.id AND mh.user_id = ?
         )
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT ?`,
      [chatId, req.authUser!.id, limit]
    );

    rows.reverse();
    res.json({ messages: hydrateMessages(rows, req.authUser!.id) });
  });

  const postMessageSchema = z.object({
    clientId: z.string().max(80).optional(),
    body: z.string().max(4000).optional().default(''),
    replyToId: z.string().optional(),
    quoteText: z.string().max(400).optional(),
    forwardedFrom: z.string().max(80).optional(),
    isSilent: z.boolean().optional().default(false),
    attachments: z
      .array(
        z.object({
          storageKey: z.string().min(1).max(300),
          url: z.string().min(1).max(1000),
          originalName: z.string().min(1).max(200),
          mimeType: z.string().min(1).max(120),
          kind: z.enum(['image', 'video', 'voice', 'document']),
          sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024),
          durationMs: z.number().int().min(0).max(3_600_000).optional().default(0),
          checksum: z.string().max(128).optional().default(''),
        })
      )
      .max(6)
      .optional()
      .default([]),
  });

  app.post('/api/v1/chats/:id/messages', requireAuth, (req: AuthRequest, res) => {
    const chatId = String(req.params.id);
    const userId = req.authUser!.id;

    const chat = dbGet<{
      id: string;
      type: string;
      assigned_bot_id: string | null;
      is_banned: number;
      ban_reason: string;
    }>(
      `SELECT id, type, assigned_bot_id, is_banned, ban_reason FROM chats WHERE id = ? AND deleted_at IS NULL`,
      [chatId]
    );
    if (!chat) {
      sendApiError(res, 404, 'CHAT_NOT_FOUND', 'Conversation not found.');
      return;
    }

    if (Boolean(chat.is_banned)) {
      sendApiError(
        res,
        403,
        'CHAT_BANNED',
        chat.ban_reason || 'This conversation has been suspended by an administrator.'
      );
      return;
    }

    const membership = getMembership(chatId, userId);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    if (chat.type === 'channel' && membership.role !== 'owner' && membership.role !== 'admin') {
      sendApiError(res, 403, 'CHANNEL_READ_ONLY', 'Only channel admins can broadcast messages.');
      return;
    }

    const parsed = postMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid message payload.');
      return;
    }

    const { clientId, body, replyToId, quoteText, forwardedFrom, isSilent, attachments } = parsed.data;
    if (!body.trim() && attachments.length === 0) {
      sendApiError(res, 400, 'EMPTY_MESSAGE', 'Message text or attachment is required.');
      return;
    }

    if (chat.type === 'direct') {
      const peer = dbGet<{ user_id: string }>(
        `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? AND left_at IS NULL`,
        [chatId, userId]
      );
      if (peer) {
        const blocked = dbGet<{ blocker_id: string }>(
          `SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
          [userId, peer.user_id, peer.user_id, userId]
        );
        if (blocked) {
          sendApiError(res, 403, 'USER_BLOCKED', 'Messaging is unavailable because a block is active.');
          return;
        }
      }
    }

    if (clientId) {
      const existing = dbGet<Record<string, unknown>>(
        `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
                u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = ? AND m.sender_id = ? AND m.client_id = ?
         LIMIT 1`,
        [chatId, userId, clientId]
      );
      if (existing) {
        res.json({ message: hydrateMessages([existing], userId)[0] });
        return;
      }
    }

    const messageId = crypto.randomUUID();
    const now = nowIso();

    withTx(() => {
      dbRun(
        `INSERT INTO messages (id, client_id, chat_id, sender_id, reply_to_id, forwarded_from, quote_text, body, is_silent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          messageId,
          clientId || null,
          chatId,
          userId,
          replyToId || null,
          forwardedFrom || null,
          quoteText || null,
          body.trim(),
          isSilent ? 1 : 0,
          now,
        ]
      );

      for (const att of attachments) {
        dbRun(
          `INSERT INTO attachments (id, message_id, storage_key, url, original_name, mime_type, kind, size_bytes, duration_ms, checksum, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            messageId,
            att.storageKey,
            att.url,
            att.originalName,
            att.mimeType,
            att.kind,
            att.sizeBytes,
            att.durationMs,
            att.checksum,
            now,
          ]
        );
      }

      dbRun(`UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?`, [now, chatId, userId]);
    });

    const row = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = ?`,
      [messageId]
    );

    const hydrated = row ? hydrateMessages([row], userId)[0] : null;
    if (hydrated) {
      publishToChat(chatId, { type: 'message:new', chatId, message: hydrated }, userId);
    }

    // If conversation is AI assistant or has assigned bot, trigger automated AI response
    const botToTrigger = chat.type === 'ai' ? 'bot_zephyrix_ai' : (chat as any).assigned_bot_id;
    if (botToTrigger) {
      setTimeout(() => {
        void triggerBotReply(chatId, botToTrigger, body.trim(), attachments[0]?.url);
      }, 100);
    }

    res.status(201).json({ message: hydrated });
  });

  app.patch('/api/v1/messages/:id', requireAuth, (req: AuthRequest, res) => {
    const msgId = String(req.params.id);
    const body = String((req.body as { body?: string })?.body || '').trim();
    if (!body || body.length > 4000) {
      sendApiError(res, 400, 'INVALID_INPUT', 'Edited message cannot be empty.');
      return;
    }

    const msg = dbGet<{ id: string; chat_id: string; sender_id: string; deleted_at: string | null }>(
      `SELECT id, chat_id, sender_id, deleted_at FROM messages WHERE id = ?`,
      [msgId]
    );
    if (!msg || msg.deleted_at) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      return;
    }
    if (msg.sender_id !== req.authUser!.id) {
      sendApiError(res, 403, 'FORBIDDEN', 'Only the sender can edit this message.');
      return;
    }

    dbRun(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`, [body, nowIso(), msgId]);
    const row = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [msgId]
    );
    const hydrated = row ? hydrateMessages([row], req.authUser!.id)[0] : null;
    if (hydrated) {
      publishToChat(msg.chat_id, { type: 'message:updated', chatId: msg.chat_id, message: hydrated });
    }
    res.json({ message: hydrated });
  });

  app.delete('/api/v1/messages/:id', requireAuth, (req: AuthRequest, res) => {
    const msgId = String(req.params.id);
    const userId = req.authUser!.id;
    const rawScope = String(
      req.query.scope ?? (req.body as { scope?: string } | undefined)?.scope ?? 'everyone'
    )
      .trim()
      .toLowerCase();
    if (rawScope !== 'me' && rawScope !== 'everyone') {
      sendApiError(res, 400, 'INVALID_SCOPE', 'Delete scope must be "me" or "everyone".');
      return;
    }

    const msg = dbGet<{ id: string; chat_id: string; sender_id: string; deleted_at: string | null }>(
      `SELECT id, chat_id, sender_id, deleted_at FROM messages WHERE id = ?`,
      [msgId]
    );
    if (!msg) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      return;
    }

    const membership = getMembership(msg.chat_id, userId);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    if (rawScope === 'me') {
      dbRun(
        `INSERT OR IGNORE INTO message_hidden_for (message_id, user_id, hidden_at) VALUES (?, ?, ?)`,
        [msgId, userId, nowIso()]
      );
      publishToUsers([userId], { type: 'message:hidden', chatId: msg.chat_id, messageIds: [msgId] });
      publishToUsers([userId], { type: 'chat:updated', chatId: msg.chat_id });
      res.json({ ok: true, scope: 'me', messageId: msgId });
      return;
    }

    const canDeleteForEveryone =
      msg.sender_id === userId || membership.role === 'owner' || membership.role === 'admin';
    if (!canDeleteForEveryone) {
      sendApiError(res, 403, 'FORBIDDEN', 'Only the message sender or group/channel admins can delete for everyone.');
      return;
    }

    if (!msg.deleted_at) {
      dbRun(`UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?`, [nowIso(), msgId]);
    }
    publishToChat(msg.chat_id, { type: 'message:deleted', chatId: msg.chat_id, messageId: msgId });
    res.json({ ok: true, scope: 'everyone', messageId: msgId });
  });

  const batchDeleteSchema = z.object({
    messageIds: z.array(z.string().min(1)).min(1).max(100),
    scope: z.enum(['me', 'everyone']),
  });

  app.post('/api/v1/messages/batch-delete', requireAuth, (req: AuthRequest, res) => {
    const userId = req.authUser!.id;
    const parsed = batchDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid delete request.');
      return;
    }

    const uniqueIds = Array.from(new Set(parsed.data.messageIds));
    const scope = parsed.data.scope;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = dbAll<{ id: string; chat_id: string; sender_id: string; deleted_at: string | null }>(
      `SELECT id, chat_id, sender_id, deleted_at FROM messages WHERE id IN (${placeholders})`,
      uniqueIds
    );
    if (rows.length === 0) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'No matching messages found.');
      return;
    }

    const roleByChat = new Map<string, 'owner' | 'admin' | 'member'>();
    for (const row of rows) {
      if (!roleByChat.has(row.chat_id)) {
        const m = getMembership(row.chat_id, userId);
        if (!m || m.left_at) {
          sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
          return;
        }
        roleByChat.set(row.chat_id, m.role);
      }
      if (scope === 'everyone') {
        const role = roleByChat.get(row.chat_id);
        const allowed = row.sender_id === userId || role === 'owner' || role === 'admin';
        if (!allowed) {
          sendApiError(
            res,
            403,
            'FORBIDDEN',
            'Only the message sender or group/channel admins can delete for everyone.'
          );
          return;
        }
      }
    }

    const now = nowIso();
    if (scope === 'me') {
      withTx(() => {
        for (const row of rows) {
          dbRun(
            `INSERT OR IGNORE INTO message_hidden_for (message_id, user_id, hidden_at) VALUES (?, ?, ?)`,
            [row.id, userId, now]
          );
        }
      });

      const byChat = new Map<string, string[]>();
      for (const row of rows) {
        const list = byChat.get(row.chat_id) || [];
        list.push(row.id);
        byChat.set(row.chat_id, list);
      }
      for (const [chatId, messageIds] of byChat.entries()) {
        publishToUsers([userId], { type: 'message:hidden', chatId, messageIds });
        publishToUsers([userId], { type: 'chat:updated', chatId });
      }
      res.json({ ok: true, scope: 'me', deletedIds: rows.map((r) => r.id) });
      return;
    }

    withTx(() => {
      for (const row of rows) {
        if (!row.deleted_at) {
          dbRun(`UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?`, [now, row.id]);
        }
      }
    });
    for (const row of rows) {
      publishToChat(row.chat_id, { type: 'message:deleted', chatId: row.chat_id, messageId: row.id });
    }
    res.json({ ok: true, scope: 'everyone', deletedIds: rows.map((r) => r.id) });
  });

  app.post('/api/v1/messages/:id/pin', requireAuth, (req: AuthRequest, res) => {
    const msgId = String(req.params.id);
    const msg = dbGet<{ id: string; chat_id: string; is_pinned: number }>(
      `SELECT id, chat_id, is_pinned FROM messages WHERE id = ?`,
      [msgId]
    );
    if (!msg) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      return;
    }
    const membership = getMembership(msg.chat_id, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }

    const nextPin = msg.is_pinned ? 0 : 1;
    dbRun(`UPDATE messages SET is_pinned = ? WHERE id = ?`, [nextPin, msgId]);

    const row = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [msgId]
    );
    const hydrated = row ? hydrateMessages([row], req.authUser!.id)[0] : null;
    if (hydrated) {
      publishToChat(msg.chat_id, { type: 'message:updated', chatId: msg.chat_id, message: hydrated });
    }
    res.json({ message: hydrated });
  });

  const reactionBodySchema = z.object({
    emoji: z.string().trim().min(1, 'Reaction emoji is required.').max(16, 'Emoji is too long.'),
  });

  app.post('/api/v1/messages/:id/reactions', requireAuth, (req: AuthRequest, res) => {
    const msgId = String(req.params.id);
    const parsed = reactionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_EMOJI', parsed.error.issues[0]?.message || 'Valid reaction emoji required.');
      return;
    }
    const emoji = parsed.data.emoji;

    const msg = dbGet<{ id: string; chat_id: string; deleted_at: string | null }>(
      `SELECT id, chat_id, deleted_at FROM messages WHERE id = ?`,
      [msgId]
    );
    if (!msg || msg.deleted_at) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      return;
    }

    const membership = getMembership(msg.chat_id, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }

    const existing = dbGet<{ emoji: string }>(
      `SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
      [msgId, req.authUser!.id, emoji]
    );
    let action: 'added' | 'removed' = 'added';
    if (existing) {
      action = 'removed';
      dbRun(`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`, [
        msgId,
        req.authUser!.id,
        emoji,
      ]);
    } else {
      dbRun(`INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`, [
        msgId,
        req.authUser!.id,
        emoji,
        nowIso(),
      ]);
    }

    const reactRows = dbAll<{ emoji: string; user_id: string; display_name: string }>(
      `SELECT r.emoji, r.user_id, u.display_name
       FROM reactions r
       JOIN users u ON u.id = r.user_id
       WHERE r.message_id = ?
       ORDER BY r.created_at ASC`,
      [msgId]
    );
    const groupedMap = new Map<string, { userIds: Set<string>; users: Array<{ id: string; displayName: string }> }>();
    for (const r of reactRows) {
      let entry = groupedMap.get(r.emoji);
      if (!entry) {
        entry = { userIds: new Set(), users: [] };
        groupedMap.set(r.emoji, entry);
      }
      const uid = String(r.user_id);
      if (!entry.userIds.has(uid)) {
        entry.userIds.add(uid);
        entry.users.push({ id: uid, displayName: String(r.display_name || 'User') });
      }
    }
    const groupedReactions = Array.from(groupedMap.entries()).map(([em, entry]) => ({
      emoji: em,
      count: entry.userIds.size,
      userIds: entry.userIds,
      users: entry.users,
    }));

    publishReactionToChat(msg.chat_id, msgId, req.authUser!.id, emoji, action, groupedReactions);

    const viewerReactions = groupedReactions.map((g) => ({
      emoji: g.emoji,
      count: g.count,
      reactedByMe: g.userIds.has(req.authUser!.id),
      users: g.users,
    }));

    const row = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [msgId]
    );
    const hydrated = row ? hydrateMessages([row], req.authUser!.id)[0] : null;
    res.json({
      ok: true,
      chatId: msg.chat_id,
      messageId: msgId,
      emoji,
      action,
      reactions: viewerReactions,
      message: hydrated,
    });
  });

  const forwardMessageSchema = z.object({
    targetChatIds: z.array(z.string().min(1)).max(20).optional().default([]),
    targetUserIds: z.array(z.string().min(1)).max(20).optional().default([]),
  });

  app.post('/api/v1/messages/:id/forward', requireAuth, (req: AuthRequest, res) => {
    const msgId = String(req.params.id);
    const userId = req.authUser!.id;
    const parsed = forwardMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid forward recipients.');
      return;
    }

    const uniqueTargetChats = Array.from(new Set(parsed.data.targetChatIds));
    const uniqueTargetUsers = Array.from(new Set(parsed.data.targetUserIds.filter((uid) => uid !== userId)));
    if (uniqueTargetChats.length + uniqueTargetUsers.length === 0) {
      sendApiError(res, 400, 'NO_RECIPIENTS', 'Select at least one recipient to forward this message.');
      return;
    }
    if (uniqueTargetChats.length + uniqueTargetUsers.length > 20) {
      sendApiError(res, 400, 'TOO_MANY_RECIPIENTS', 'You can forward to at most 20 recipients at once.');
      return;
    }

    const sourceMsg = dbGet<Record<string, unknown>>(
      `SELECT m.id, m.chat_id, m.sender_id, m.body, m.forwarded_from, m.deleted_at, u.display_name AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_hidden_for mh
           WHERE mh.message_id = m.id AND mh.user_id = ?
         )`,
      [msgId, userId]
    );
    if (!sourceMsg || sourceMsg.deleted_at) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      return;
    }

    const sourceMembership = getMembership(String(sourceMsg.chat_id), userId);
    if (!sourceMembership || sourceMembership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'You do not have access to this message.');
      return;
    }

    const sourceAttachments = dbAll<Record<string, unknown>>(
      `SELECT storage_key, url, original_name, mime_type, kind, size_bytes, duration_ms, checksum
       FROM attachments WHERE message_id = ?`,
      [msgId]
    );

    const forwardBody = String(sourceMsg.body || '').trim();
    if (!forwardBody && sourceAttachments.length === 0) {
      sendApiError(res, 400, 'EMPTY_MESSAGE', 'Nothing to forward.');
      return;
    }

    const forwardedFromLabel = sourceMsg.forwarded_from
      ? String(sourceMsg.forwarded_from)
      : String(sourceMsg.sender_name || '');

    const now = nowIso();
    const resolvedChatIds = new Set<string>(uniqueTargetChats);
    const newlyCreatedUsers: Array<{ chatId: string; userId: string }> = [];

    for (const targetUserId of uniqueTargetUsers) {
      const targetUser = dbGet<{ id: string }>(
        `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
        [targetUserId]
      );
      if (!targetUser) continue;

      const blocked = dbGet<{ blocker_id: string }>(
        `SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [userId, targetUserId, targetUserId, userId]
      );
      if (blocked) continue;

      const existingDm = dbGet<{ id: string }>(
        `SELECT c.id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ? AND m1.left_at IS NULL
         JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ? AND m2.left_at IS NULL
         WHERE c.type = 'direct' AND c.deleted_at IS NULL
         LIMIT 1`,
        [userId, targetUserId]
      );
      if (existingDm) {
        resolvedChatIds.add(existingDm.id);
      } else {
        const newDmId = crypto.randomUUID();
        const pairIds = [userId, targetUserId].sort();
        const zegoRoomId = `dm_${pairIds[0].slice(0, 8)}_${pairIds[1].slice(0, 8)}`;
        withTx(() => {
          dbRun(
            `INSERT INTO chats (id, type, title, zego_room_id, created_by, created_at)
             VALUES (?, 'direct', '', ?, ?, ?)`,
            [newDmId, zegoRoomId, userId, now]
          );
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            newDmId,
            userId,
            now,
          ]);
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            newDmId,
            targetUserId,
            now,
          ]);
        });
        resolvedChatIds.add(newDmId);
        newlyCreatedUsers.push({ chatId: newDmId, userId: targetUserId });
      }
    }

    const forwardedMessageIds: Array<{ chatId: string; messageId: string }> = [];

    withTx(() => {
      for (const destChatId of resolvedChatIds) {
        const destChat = dbGet<{ id: string; type: string; is_banned: number }>(
          `SELECT id, type, is_banned FROM chats WHERE id = ? AND deleted_at IS NULL`,
          [destChatId]
        );
        if (!destChat || destChat.is_banned) continue;

        const destMembership = getMembership(destChatId, userId);
        if (!destMembership || destMembership.left_at) continue;

        if (destChat.type === 'channel' && destMembership.role !== 'owner' && destMembership.role !== 'admin') {
          continue;
        }

        if (destChat.type === 'direct') {
          const peer = dbGet<{ user_id: string }>(
            `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? AND left_at IS NULL`,
            [destChatId, userId]
          );
          if (peer) {
            const blocked = dbGet<{ blocker_id: string }>(
              `SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
              [userId, peer.user_id, peer.user_id, userId]
            );
            if (blocked) continue;
          }
        }

        const newMessageId = crypto.randomUUID();
        dbRun(
          `INSERT INTO messages (id, client_id, chat_id, sender_id, forwarded_from, body, is_silent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [newMessageId, null, destChatId, userId, forwardedFromLabel, forwardBody, now]
        );

        for (const att of sourceAttachments) {
          dbRun(
            `INSERT INTO attachments (id, message_id, storage_key, url, original_name, mime_type, kind, size_bytes, duration_ms, checksum, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(),
              newMessageId,
              String(att.storage_key),
              String(att.url),
              String(att.original_name),
              String(att.mime_type),
              String(att.kind),
              Number(att.size_bytes || 0),
              Number(att.duration_ms || 0),
              String(att.checksum || ''),
              now,
            ]
          );
        }

        dbRun(`UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?`, [now, destChatId, userId]);
        forwardedMessageIds.push({ chatId: destChatId, messageId: newMessageId });
      }
    });

    if (forwardedMessageIds.length === 0) {
      sendApiError(res, 403, 'FORWARD_FAILED', 'Unable to forward to any of the selected recipients.');
      return;
    }

    for (const item of newlyCreatedUsers) {
      publishToUsers([item.userId], { type: 'chat:updated', chatId: item.chatId });
    }

    const hydratedMessages: Record<string, unknown>[] = [];
    for (const item of forwardedMessageIds) {
      const row = dbGet<Record<string, unknown>>(
        `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
                u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`,
        [item.messageId]
      );
      const hydrated = row ? hydrateMessages([row], userId)[0] : null;
      if (hydrated) {
        hydratedMessages.push(hydrated);
        publishToChat(item.chatId, { type: 'message:new', chatId: item.chatId, message: hydrated }, userId);
      }
      publishToChat(item.chatId, { type: 'chat:updated', chatId: item.chatId });
    }

    res.status(201).json({
      ok: true,
      forwardedCount: forwardedMessageIds.length,
      chatIds: forwardedMessageIds.map((f) => f.chatId),
      messages: hydratedMessages,
    });
  });

  const batchForwardSchema = z.object({
    messageIds: z.array(z.string().min(1)).min(1).max(50),
    targetChatIds: z.array(z.string().min(1)).max(20).optional().default([]),
    targetUserIds: z.array(z.string().min(1)).max(20).optional().default([]),
  });

  app.post('/api/v1/messages/forward-batch', requireAuth, (req: AuthRequest, res) => {
    const userId = req.authUser!.id;
    const parsed = batchForwardSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message || 'Invalid forward request.');
      return;
    }

    const uniqueMessageIds = Array.from(new Set(parsed.data.messageIds));
    const uniqueTargetChats = Array.from(new Set(parsed.data.targetChatIds));
    const uniqueTargetUsers = Array.from(new Set(parsed.data.targetUserIds.filter((uid) => uid !== userId)));
    if (uniqueTargetChats.length + uniqueTargetUsers.length === 0) {
      sendApiError(res, 400, 'NO_RECIPIENTS', 'Select at least one recipient to forward messages.');
      return;
    }
    if (uniqueTargetChats.length + uniqueTargetUsers.length > 20) {
      sendApiError(res, 400, 'TOO_MANY_RECIPIENTS', 'You can forward to at most 20 recipients at once.');
      return;
    }

    const placeholders = uniqueMessageIds.map(() => '?').join(', ');
    const sourceRows = dbAll<Record<string, unknown>>(
      `SELECT m.id, m.chat_id, m.sender_id, m.body, m.forwarded_from, m.deleted_at, m.created_at,
              u.display_name AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id IN (${placeholders})
         AND m.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM message_hidden_for mh
           WHERE mh.message_id = m.id AND mh.user_id = ?
         )
       ORDER BY m.created_at ASC, m.rowid ASC`,
      [...uniqueMessageIds, userId]
    );

    if (sourceRows.length === 0) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'No valid messages found to forward.');
      return;
    }

    const checkedSourceChats = new Set<string>();
    for (const row of sourceRows) {
      const srcChatId = String(row.chat_id);
      if (!checkedSourceChats.has(srcChatId)) {
        const srcMembership = getMembership(srcChatId, userId);
        if (!srcMembership || srcMembership.left_at) {
          sendApiError(res, 403, 'FORBIDDEN', 'You do not have access to one or more selected messages.');
          return;
        }
        checkedSourceChats.add(srcChatId);
      }
    }

    const srcIds = sourceRows.map((r) => String(r.id));
    const srcAttPlaceholders = srcIds.map(() => '?').join(', ');
    const allAttRows = dbAll<Record<string, unknown>>(
      `SELECT message_id, storage_key, url, original_name, mime_type, kind, size_bytes, duration_ms, checksum
       FROM attachments WHERE message_id IN (${srcAttPlaceholders})
       ORDER BY created_at ASC`,
      srcIds
    );
    const attsBySourceMsg = new Map<string, Record<string, unknown>[]>();
    for (const att of allAttRows) {
      const mid = String(att.message_id);
      const list = attsBySourceMsg.get(mid) || [];
      list.push(att);
      attsBySourceMsg.set(mid, list);
    }

    const forwardableItems = sourceRows
      .map((row) => {
        const id = String(row.id);
        const bodyText = String(row.body || '').trim();
        const attachments = attsBySourceMsg.get(id) || [];
        const forwardedFromLabel = row.forwarded_from
          ? String(row.forwarded_from)
          : String(row.sender_name || '');
        return { id, bodyText, attachments, forwardedFromLabel };
      })
      .filter((item) => item.bodyText.length > 0 || item.attachments.length > 0);

    if (forwardableItems.length === 0) {
      sendApiError(res, 400, 'EMPTY_MESSAGE', 'Nothing to forward.');
      return;
    }

    const now = nowIso();
    const resolvedChatIds = new Set<string>(uniqueTargetChats);
    const newlyCreatedUsers: Array<{ chatId: string; userId: string }> = [];

    for (const targetUserId of uniqueTargetUsers) {
      const targetUser = dbGet<{ id: string }>(
        `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
        [targetUserId]
      );
      if (!targetUser) continue;

      const blocked = dbGet<{ blocker_id: string }>(
        `SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [userId, targetUserId, targetUserId, userId]
      );
      if (blocked) continue;

      const existingDm = dbGet<{ id: string }>(
        `SELECT c.id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ? AND m1.left_at IS NULL
         JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ? AND m2.left_at IS NULL
         WHERE c.type = 'direct' AND c.deleted_at IS NULL
         LIMIT 1`,
        [userId, targetUserId]
      );
      if (existingDm) {
        resolvedChatIds.add(existingDm.id);
      } else {
        const newDmId = crypto.randomUUID();
        const pairIds = [userId, targetUserId].sort();
        const zegoRoomId = `dm_${pairIds[0].slice(0, 8)}_${pairIds[1].slice(0, 8)}`;
        withTx(() => {
          dbRun(
            `INSERT INTO chats (id, type, title, zego_room_id, created_by, created_at)
             VALUES (?, 'direct', '', ?, ?, ?)`,
            [newDmId, zegoRoomId, userId, now]
          );
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            newDmId,
            userId,
            now,
          ]);
          dbRun(`INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [
            newDmId,
            targetUserId,
            now,
          ]);
        });
        resolvedChatIds.add(newDmId);
        newlyCreatedUsers.push({ chatId: newDmId, userId: targetUserId });
      }
    }

    const baseTimeMs = Date.now();
    const forwardedRecords: Array<{ chatId: string; messageId: string }> = [];
    const destinationChatIds = new Set<string>();

    withTx(() => {
      for (const destChatId of resolvedChatIds) {
        const destChat = dbGet<{ id: string; type: string; is_banned: number }>(
          `SELECT id, type, is_banned FROM chats WHERE id = ? AND deleted_at IS NULL`,
          [destChatId]
        );
        if (!destChat || Boolean(destChat.is_banned)) continue;

        const destMembership = getMembership(destChatId, userId);
        if (!destMembership || destMembership.left_at) continue;

        if (destChat.type === 'channel' && destMembership.role !== 'owner' && destMembership.role !== 'admin') {
          continue;
        }

        if (destChat.type === 'direct') {
          const peer = dbGet<{ user_id: string }>(
            `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? AND left_at IS NULL`,
            [destChatId, userId]
          );
          if (peer) {
            const blocked = dbGet<{ blocker_id: string }>(
              `SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
              [userId, peer.user_id, peer.user_id, userId]
            );
            if (blocked) continue;
          }
        }

        let lastTs = now;
        forwardableItems.forEach((item, idx) => {
          const newMessageId = crypto.randomUUID();
          const createdTs = new Date(baseTimeMs + idx).toISOString();
          lastTs = createdTs;

          dbRun(
            `INSERT INTO messages (id, client_id, chat_id, sender_id, forwarded_from, body, is_silent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
            [newMessageId, null, destChatId, userId, item.forwardedFromLabel, item.bodyText, createdTs]
          );

          for (const att of item.attachments) {
            dbRun(
              `INSERT INTO attachments (id, message_id, storage_key, url, original_name, mime_type, kind, size_bytes, duration_ms, checksum, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                crypto.randomUUID(),
                newMessageId,
                String(att.storage_key),
                String(att.url),
                String(att.original_name),
                String(att.mime_type),
                String(att.kind),
                Number(att.size_bytes || 0),
                Number(att.duration_ms || 0),
                String(att.checksum || ''),
                createdTs,
              ]
            );
          }

          forwardedRecords.push({ chatId: destChatId, messageId: newMessageId });
        });

        dbRun(`UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?`, [
          lastTs,
          destChatId,
          userId,
        ]);
        destinationChatIds.add(destChatId);
      }
    });

    if (forwardedRecords.length === 0) {
      sendApiError(res, 403, 'FORWARD_FAILED', 'Unable to forward to any of the selected recipients.');
      return;
    }

    for (const item of newlyCreatedUsers) {
      publishToUsers([item.userId], { type: 'chat:updated', chatId: item.chatId });
    }

    const hydratedMessages: Record<string, unknown>[] = [];
    for (const item of forwardedRecords) {
      const row = dbGet<Record<string, unknown>>(
        `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
                u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`,
        [item.messageId]
      );
      const hydrated = row ? hydrateMessages([row], userId)[0] : null;
      if (hydrated) {
        hydratedMessages.push(hydrated);
        publishToChat(item.chatId, { type: 'message:new', chatId: item.chatId, message: hydrated });
      }
    }
    for (const destChatId of destinationChatIds) {
      publishToChat(destChatId, { type: 'chat:updated', chatId: destChatId });
    }

    res.status(201).json({
      ok: true,
      forwardedCount: destinationChatIds.size,
      forwardedMessagesCount: forwardableItems.length,
      chatIds: Array.from(destinationChatIds),
      messages: hydratedMessages,
    });
  });

  // ZEGOCLOUD Token04 Minting (Server Secret stays strictly on backend)
  app.post('/api/v1/zego/token', requireAuth, (req: AuthRequest, res) => {
    const creds = getZegoCredentials();
    if (!creds) {
      sendApiError(
        res,
        503,
        'ZEGO_NOT_CONFIGURED',
        'ZEGOCLOUD credentials (ZEGO_APP_ID and 32-char ZEGO_SERVER_SECRET) are not configured on the server.'
      );
      return;
    }

    const ttlSeconds = 7200;
    const token = generateToken04(creds.appId, req.authUser!.id, creds.serverSecret, ttlSeconds);
    res.json({
      appID: creds.appId,
      userID: req.authUser!.id,
      userName: req.authUser!.display_name,
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  });

  // Audio / Video / Group Call Invitation Signaling & History
  app.post('/api/v1/calls', requireAuth, (req: AuthRequest, res) => {
    const body = req.body as { chatId?: string; callType?: 'audio' | 'video' | 'group' };
    const chatId = String(body.chatId || '').trim();
    const callType = body.callType === 'audio' || body.callType === 'video' || body.callType === 'group' ? body.callType : 'video';

    const chat = dbGet<{ id: string; type: string; zego_room_id: string | null }>(
      `SELECT id, type, zego_room_id FROM chats WHERE id = ? AND deleted_at IS NULL`,
      [chatId]
    );
    if (!chat) {
      sendApiError(res, 404, 'CHAT_NOT_FOUND', 'Conversation not found.');
      return;
    }

    const membership = getMembership(chatId, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Not a member of this conversation.');
      return;
    }

    const callId = crypto.randomUUID();
    const roomId = chat.zego_room_id || `call_${chatId.slice(0, 12)}`;
    const now = nowIso();

    dbRun(
      `INSERT INTO call_logs (id, chat_id, caller_id, call_type, room_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'ringing', ?)`,
      [callId, chatId, req.authUser!.id, callType, roomId, now]
    );

    publishToChat(
      chatId,
      {
        type: 'call:invite',
        callId,
        chatId,
        roomId,
        callType,
        caller: {
          id: req.authUser!.id,
          displayName: req.authUser!.display_name,
          username: req.authUser!.username,
          avatarUrl: req.authUser!.avatar_url,
        },
      },
      req.authUser!.id
    );

    res.status(201).json({ callId, chatId, roomId, callType });
  });

  app.post('/api/v1/calls/:callId/status', requireAuth, (req: AuthRequest, res) => {
    const callId = String(req.params.callId);
    const rawStatus = String((req.body as { status?: string })?.status || 'ended').trim();
    const allowedStatuses = new Set(['active', 'ended', 'declined', 'missed']);
    if (!allowedStatuses.has(rawStatus)) {
      sendApiError(res, 400, 'INVALID_STATUS', 'Unsupported call status.');
      return;
    }

    const call = dbGet<{ id: string; chat_id: string }>(`SELECT id, chat_id FROM call_logs WHERE id = ?`, [callId]);
    if (!call) {
      sendApiError(res, 404, 'CALL_NOT_FOUND', 'Call record not found.');
      return;
    }

    const membership = getMembership(call.chat_id, req.authUser!.id);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }

    dbRun(`UPDATE call_logs SET status = ?, ended_at = ? WHERE id = ?`, [rawStatus, nowIso(), callId]);
    if (rawStatus === 'declined' || rawStatus === 'ended' || rawStatus === 'missed') {
      publishToChat(call.chat_id, { type: 'call:ended', callId, chatId: call.chat_id, reason: rawStatus });
    }
    res.json({ ok: true });
  });

  async function generateBotCompletion(params: {
    provider: string;
    model: string;
    prompt: string;
    systemInstruction: string;
    apiEndpoint?: string;
    apiKey?: string;
    attachmentUrl?: string;
  }): Promise<{ reply?: string; error?: string }> {
    const provider = (params.provider || 'gemini').trim().toLowerCase();
    const model = (params.model || 'gemini-4-hydrogen').trim();
    const systemInstruction =
      params.systemInstruction ||
      'You are Zephyrix AI Assistant, a friendly, intelligent, and multimodal companion built into Zephyrix. Provide helpful, accurate, and concise responses in English or Bengali depending on the user query.';

    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        return {
          error:
            'Gemini AI is not configured on the server yet. Add GEMINI_API_KEY in your environment variables to enable live AI replies.',
        };
      }
      try {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: { 'User-Agent': 'aistudio-build' },
          },
        });
        const resp = await ai.models.generateContent({
          model,
          contents: params.prompt,
          config: {
            systemInstruction,
          },
        });
        if (!resp.text) {
          return { error: `Model (${model}) returned an empty response.` };
        }
        return { reply: resp.text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.error('[bot] Gemini generation error:', msg);
        return { error: `Gemini AI error (${model}): ${msg}` };
      }
    }

    const endpoint = String(params.apiEndpoint || '').trim();
    if (!endpoint) {
      return { error: 'Custom endpoint URL is required for non-Gemini bots.' };
    }
    if (!isSafeExternalHttpUrl(endpoint)) {
      return { error: 'Custom endpoint URL must be a valid public HTTP or HTTPS URL.' };
    }

    const requestBody =
      provider === 'openai'
        ? {
            model,
            messages: [
              { role: 'system', content: systemInstruction },
              { role: 'user', content: params.prompt },
            ],
          }
        : {
            prompt: params.prompt,
            systemInstruction,
            model,
            attachmentUrl: params.attachmentUrl,
          };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        return { error: `Custom endpoint returned HTTP ${res.status}.` };
      }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (json && typeof json.reply === 'string') {
        return { reply: json.reply };
      }
      if (json && typeof json.text === 'string') {
        return { reply: json.text };
      }
      if (json && Array.isArray((json as any).choices) && (json as any).choices[0]?.message?.content) {
        return { reply: String((json as any).choices[0].message.content) };
      }
      return { error: 'Endpoint responded without a recognized reply, text, or choices[0].message.content field.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error('[bot] Custom endpoint error:', msg);
      return { error: `Failed to reach custom AI endpoint: ${msg}` };
    }
  }

  async function triggerBotReply(
    chatId: string,
    botId: string,
    userPrompt: string,
    attachmentUrl?: string
  ): Promise<Record<string, unknown> | null> {
    const bot = dbGet<Record<string, unknown>>(`SELECT * FROM bots WHERE id = ?`, [botId]) || {
      id: 'bot_zephyrix_ai',
      name: 'Zephyrix AI Assistant',
      handle: 'zephyrix_ai',
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      system_instruction:
        'You are Zephyrix AI Assistant, a friendly, intelligent, and multimodal companion built into Zephyrix. Provide helpful, accurate, and concise responses in English or Bengali depending on the user query.',
      is_verified: 1,
    };

    const botUserId = String(bot.id || 'bot_zephyrix_ai');
    const botName = String(bot.name || 'Zephyrix AI Assistant');
    const botHandle = String(bot.handle || 'zephyrix_ai');
    const botIsVerified = Boolean(bot.is_verified);

    // Ensure bot exists in users table so foreign keys and joins work flawlessly
    dbRun(
      `INSERT INTO users (id, email, password_hash, username, display_name, verified_flag, developer_badge, preferred_locale, last_seen_at, created_at)
       VALUES (?, ?, 'BOT_NO_LOGIN', ?, ?, ?, 0, 'en', datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username, verified_flag = excluded.verified_flag`,
      [botUserId, `${botHandle}@zephyrix.ai`, botHandle, botName, botIsVerified ? 1 : 0]
    );

    let prompt = userPrompt;
    if (attachmentUrl) {
      prompt = `[User uploaded attachment: ${attachmentUrl}]\n${userPrompt || 'Please review this file or voice note.'}`;
    }

    const result = await generateBotCompletion({
      provider: String(bot.provider || 'gemini'),
      model: String(bot.model || 'gemini-4-hydrogen'),
      prompt,
      systemInstruction: String(bot.system_instruction || ''),
      apiEndpoint: bot.api_endpoint ? String(bot.api_endpoint) : undefined,
      apiKey: bot.api_key ? String(bot.api_key) : undefined,
      attachmentUrl,
    });

    const replyText = result.reply || result.error || `Unable to generate a response right now.`;

    const aiMsgId = crypto.randomUUID();
    const aiNow = nowIso();
    dbRun(
      `INSERT INTO messages (id, chat_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      [aiMsgId, chatId, botUserId, replyText, aiNow]
    );

    const aiMsgRow = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = ?`,
      [aiMsgId]
    );
    const hydrated = aiMsgRow ? hydrateMessages([aiMsgRow], '')[0] : null;
    if (hydrated) {
      publishToChat(chatId, { type: 'message:new', chatId, message: hydrated });
    }
    return hydrated;
  }

  // Zephyrix AI Assistant endpoint (supports text, file attachments & voice notes)
  app.post('/api/v1/ai/chat', requireAuth, async (req: AuthRequest, res) => {
    const userId = req.authUser!.id;
    const body = req.body as { chatId?: string; message?: string; attachmentUrl?: string; botId?: string };
    const chatId = String(body.chatId || '').trim();
    const promptText = String(body.message || '').trim();

    if (!chatId || !promptText) {
      sendApiError(res, 400, 'INVALID_INPUT', 'chatId and message are required.');
      return;
    }

    const chat = dbGet<{ id: string; type: string; assigned_bot_id: string | null }>(
      `SELECT id, type, assigned_bot_id FROM chats WHERE id = ? AND deleted_at IS NULL`,
      [chatId]
    );
    if (!chat) {
      sendApiError(res, 404, 'CHAT_NOT_FOUND', 'Conversation not found.');
      return;
    }

    const membership = getMembership(chatId, userId);
    if (!membership || membership.left_at) {
      sendApiError(res, 403, 'FORBIDDEN', 'Access denied.');
      return;
    }

    const now = nowIso();
    const userMsgId = crypto.randomUUID();

    withTx(() => {
      dbRun(
        `INSERT INTO messages (id, chat_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
        [userMsgId, chatId, userId, promptText, now]
      );
      if (body.attachmentUrl) {
        const attId = crypto.randomUUID();
        dbRun(
          `INSERT INTO attachments (id, message_id, storage_key, url, original_name, mime_type, kind, size_bytes)
           VALUES (?, ?, ?, ?, 'Attachment', 'application/octet-stream', 'document', 1024)`,
          [attId, userMsgId, body.attachmentUrl, body.attachmentUrl]
        );
      }
    });

    const userMsgRow = dbGet<Record<string, unknown>>(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar_url AS sender_avatar, u.verified_flag AS sender_verified, u.developer_badge AS sender_developer_badge
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [userMsgId]
    );
    const hydratedUserMsg = userMsgRow ? hydrateMessages([userMsgRow], userId)[0] : null;
    if (hydratedUserMsg) {
      publishToChat(chatId, { type: 'message:new', chatId, message: hydratedUserMsg });
    }

    const botIdToUse = body.botId || chat.assigned_bot_id || 'bot_zephyrix_ai';
    const hydratedAiMsg = await triggerBotReply(chatId, botIdToUse, promptText, body.attachmentUrl);

    res.json({ message: hydratedAiMsg });
  });

  // Admin: Get all users
  app.get('/api/v1/admin/users', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const users = dbAll<Record<string, unknown>>(
      `SELECT id, email, username, display_name, phone, country, bio, avatar_url, is_admin, is_banned, ban_reason, verified_flag, developer_badge, created_at, last_seen_at
       FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC`
    );
    res.json({ users });
  });

  // Admin: Get audit logs
  app.get('/api/v1/admin/audit-logs', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const logs = dbAll<Record<string, unknown>>(
      `SELECT al.id, al.action, al.target_id, al.details, al.created_at,
              u.display_name AS admin_name, u.username AS admin_username
       FROM audit_logs al
       JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC
       LIMIT 100`
    );
    res.json({ logs });
  });

  // Admin: Update user badges (verified, developer)
  app.patch('/api/v1/admin/users/:id/badges', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const targetId = String(req.params.id);
    const body = req.body as { verified?: boolean; developer?: boolean };

    const updates: string[] = [];
    const params: (string | number)[] = [];
    if (typeof body.verified === 'boolean') {
      updates.push('verified_flag = ?');
      params.push(body.verified ? 1 : 0);
    }
    if (typeof body.developer === 'boolean') {
      updates.push('developer_badge = ?');
      params.push(body.developer ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(targetId);
      dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
      recordAuditLog(req.authUser!.id, 'UPDATE_USER_BADGES', targetId, JSON.stringify(body));
    }
    res.json({ ok: true });
  });

  // Admin: Update user privileges or ban status
  app.patch('/api/v1/admin/users/:id', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const targetId = String(req.params.id);
    const body = req.body as { isAdmin?: boolean; isBanned?: boolean; banReason?: string };

    const targetUser = dbGet<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ?`, [targetId]);
    if (!targetUser) {
      sendApiError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      return;
    }

    const updates: string[] = [];
    const params: (string | number)[] = [];
    if (typeof body.isAdmin === 'boolean') {
      updates.push('is_admin = ?');
      params.push(body.isAdmin ? 1 : 0);
    }
    if (typeof body.isBanned === 'boolean') {
      updates.push('is_banned = ?');
      params.push(body.isBanned ? 1 : 0);
      updates.push('ban_reason = ?');
      params.push(body.isBanned ? String(body.banReason || 'Account suspended by administrator.') : '');
    }

    if (updates.length > 0) {
      params.push(targetId);
      dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

      if (typeof body.isAdmin === 'boolean') {
        recordAuditLog(
          req.authUser!.id,
          body.isAdmin ? 'GRANT_ADMIN' : 'REVOKE_ADMIN',
          targetId,
          `Target user: ${targetUser.display_name}`
        );
      }
      if (typeof body.isBanned === 'boolean') {
        recordAuditLog(
          req.authUser!.id,
          body.isBanned ? 'BAN_USER' : 'UNBAN_USER',
          targetId,
          body.isBanned ? String(body.banReason || 'Account suspended by administrator.') : `Ban lifted for ${targetUser.display_name}`
        );
      }

      if (body.isBanned) {
        const savedChat = dbGet<{ id: string }>(`SELECT id FROM chats WHERE type = 'saved' AND created_by = ? LIMIT 1`, [targetId]);
        if (savedChat) {
          const notifMsgId = crypto.randomUUID();
          const noticeText = `Administrator Notice: Your account has been suspended. Reason: ${body.banReason || 'Policy violation'}`;
          dbRun(
            `INSERT INTO messages (id, chat_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
            [notifMsgId, savedChat.id, req.authUser!.id, noticeText, nowIso()]
          );
          publishToChat(savedChat.id, { type: 'chat:updated', chatId: savedChat.id });
        }
      }
    }

    res.json({ ok: true });
  });

  // Admin: Get all groups & channels
  app.get('/api/v1/admin/chats', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const chats = dbAll<Record<string, unknown>>(
      `SELECT c.id, c.type, c.title, c.description, c.invite_code, c.is_banned, c.ban_reason, c.created_at,
              u.display_name AS owner_name
       FROM chats c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.type IN ('group', 'channel') AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`
    );
    res.json({ chats });
  });

  // Admin: Ban or unban group/channel
  app.patch('/api/v1/admin/chats/:id/ban', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const chatId = String(req.params.id);
    const body = req.body as { isBanned?: boolean; banReason?: string };
    const isBanned = Boolean(body.isBanned);
    const banReason = String(body.banReason || 'Group or channel banned by administrator.');

    dbRun(`UPDATE chats SET is_banned = ?, ban_reason = ? WHERE id = ?`, [isBanned ? 1 : 0, isBanned ? banReason : '', chatId]);
    recordAuditLog(
      req.authUser!.id,
      isBanned ? 'BAN_CHAT' : 'UNBAN_CHAT',
      chatId,
      isBanned ? banReason : 'Chat ban lifted'
    );

    if (isBanned) {
      const noticeText = `Administrator Notice: This channel/group has been banned. Reason: ${banReason}`;
      const notifMsgId = crypto.randomUUID();
      dbRun(
        `INSERT INTO messages (id, chat_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
        [notifMsgId, chatId, req.authUser!.id, noticeText, nowIso()]
      );
    }

    publishToChat(chatId, { type: 'chat:updated', chatId });
    res.json({ ok: true });
  });

  // Admin: Bot Manager - Get all registered bots
  app.get('/api/v1/admin/bots', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const bots = dbAll<Record<string, unknown>>(
      `SELECT b.*, c.title AS assigned_chat_title
       FROM bots b
       LEFT JOIN chats c ON c.id = b.assigned_chat_id
       ORDER BY b.created_at ASC`
    );
    res.json({
      bots: bots.map((b) => ({
        id: String(b.id),
        name: String(b.name),
        handle: String(b.handle),
        avatar_url: b.avatar_url ? String(b.avatar_url) : null,
        description: String(b.description || ''),
        provider: String(b.provider || 'gemini'),
        model: String(b.model || 'gemini-4-hydrogen'),
        api_endpoint: String(b.api_endpoint || ''),
        system_instruction: String(b.system_instruction || ''),
        is_verified: Boolean(b.is_verified),
        assigned_chat_id: b.assigned_chat_id ? String(b.assigned_chat_id) : null,
        assigned_chat_title: b.assigned_chat_title ? String(b.assigned_chat_title) : null,
        created_at: String(b.created_at),
      })),
    });
  });

  // Admin: Prompt Studio Sandbox Test Endpoint
  app.post('/api/v1/admin/bots/test', requireAuth, async (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }

    const body = req.body as {
      prompt?: string;
      systemInstruction?: string;
      model?: string;
      provider?: string;
      apiEndpoint?: string;
      apiKey?: string;
      botId?: string;
    };

    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      sendApiError(res, 400, 'INVALID_INPUT', 'A test prompt is required.');
      return;
    }

    let resolvedApiKey = body.apiKey ? String(body.apiKey).trim() : '';
    if (!resolvedApiKey && body.botId) {
      const existingBot = dbGet<{ api_key: string | null }>(`SELECT api_key FROM bots WHERE id = ?`, [
        String(body.botId),
      ]);
      if (existingBot?.api_key) {
        resolvedApiKey = existingBot.api_key;
      }
    }

    const result = await generateBotCompletion({
      provider: String(body.provider || 'gemini'),
      model: String(body.model || 'gemini-4-hydrogen'),
      prompt,
      systemInstruction: String(body.systemInstruction || ''),
      apiEndpoint: body.apiEndpoint ? String(body.apiEndpoint).trim() : undefined,
      apiKey: resolvedApiKey || undefined,
    });

    if (result.error) {
      sendApiError(res, 400, 'BOT_TEST_FAILED', result.error);
      return;
    }

    res.json({ reply: result.reply || '' });
  });

  // Admin: Bot Manager - Register new AI Bot
  app.post('/api/v1/admin/bots', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const body = req.body as {
      name?: string;
      handle?: string;
      avatar_url?: string;
      description?: string;
      provider?: string;
      model?: string;
      api_endpoint?: string;
      api_key?: string;
      system_instruction?: string;
      is_verified?: boolean;
      assigned_chat_id?: string;
    };

    const name = String(body.name || '').trim();
    const handle = String(body.handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!name || !handle) {
      sendApiError(res, 400, 'INVALID_INPUT', 'Bot name and handle are required.');
      return;
    }

    const endpoint = String(body.api_endpoint || '').trim();
    if (endpoint && !isSafeExternalHttpUrl(endpoint)) {
      sendApiError(res, 400, 'INVALID_ENDPOINT', 'API endpoint must be a valid public HTTP or HTTPS URL.');
      return;
    }

    const existing = dbGet<{ id: string }>(`SELECT id FROM bots WHERE handle = ?`, [handle]);
    if (existing) {
      sendApiError(res, 409, 'HANDLE_EXISTS', 'A bot with this handle already exists.');
      return;
    }

    const botId = `bot_${crypto.randomUUID()}`;
    const now = nowIso();
    const assignedChatId = body.assigned_chat_id ? String(body.assigned_chat_id).trim() : null;
    const isVerified = body.is_verified !== false ? 1 : 0;

    withTx(() => {
      dbRun(
        `INSERT INTO bots (id, name, handle, avatar_url, description, provider, model, api_endpoint, api_key, system_instruction, is_verified, assigned_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          botId,
          name,
          handle,
          body.avatar_url || null,
          body.description || '',
          body.provider || 'gemini',
          body.model || 'gemini-4-hydrogen',
          body.api_endpoint || '',
          body.api_key || '',
          body.system_instruction || '',
          isVerified,
          assignedChatId,
          now,
        ]
      );

      // Create bot user in users table for FK integrity and verified badge display
      dbRun(
        `INSERT INTO users (id, email, password_hash, username, display_name, verified_flag, developer_badge, preferred_locale, last_seen_at, created_at)
         VALUES (?, ?, 'BOT_NO_LOGIN', ?, ?, ?, 0, 'en', datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username, verified_flag = excluded.verified_flag`,
        [botId, `${handle}@zephyrix.ai`, handle, name, isVerified]
      );

      if (assignedChatId) {
        dbRun(`UPDATE chats SET assigned_bot_id = ? WHERE id = ?`, [botId, assignedChatId]);
        dbRun(
          `INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'member', datetime('now'), datetime('now'))`,
          [assignedChatId, botId]
        );
      }
    });

    const row = dbGet<Record<string, unknown>>(`SELECT * FROM bots WHERE id = ?`, [botId]);
    res.status(201).json({ bot: row });
  });

  // Admin: Bot Manager - Update bot settings, verified badge, or assigned channel
  app.patch('/api/v1/admin/bots/:id', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const botId = String(req.params.id);
    const body = req.body as {
      name?: string;
      handle?: string;
      description?: string;
      provider?: string;
      model?: string;
      api_endpoint?: string;
      api_key?: string;
      system_instruction?: string;
      is_verified?: boolean;
      assigned_chat_id?: string | null;
    };

    const existing = dbGet<{ id: string; assigned_chat_id: string | null }>(`SELECT id, assigned_chat_id FROM bots WHERE id = ?`, [botId]);
    if (!existing) {
      sendApiError(res, 404, 'BOT_NOT_FOUND', 'Bot record not found.');
      return;
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (typeof body.name === 'string') {
      updates.push('name = ?');
      params.push(body.name.trim());
    }
    if (typeof body.handle === 'string') {
      updates.push('handle = ?');
      params.push(body.handle.trim().replace(/^@/, '').toLowerCase());
    }
    if (typeof body.description === 'string') {
      updates.push('description = ?');
      params.push(body.description.trim());
    }
    if (typeof body.provider === 'string') {
      updates.push('provider = ?');
      params.push(body.provider);
    }
    if (typeof body.model === 'string') {
      updates.push('model = ?');
      params.push(body.model);
    }
    if (typeof body.api_endpoint === 'string') {
      const trimmedEndpoint = body.api_endpoint.trim();
      if (trimmedEndpoint && !isSafeExternalHttpUrl(trimmedEndpoint)) {
        sendApiError(res, 400, 'INVALID_ENDPOINT', 'API endpoint must be a valid public HTTP or HTTPS URL.');
        return;
      }
      updates.push('api_endpoint = ?');
      params.push(trimmedEndpoint);
    }
    if (typeof body.api_key === 'string') {
      updates.push('api_key = ?');
      params.push(body.api_key);
    }
    if (typeof body.system_instruction === 'string') {
      updates.push('system_instruction = ?');
      params.push(body.system_instruction);
    }
    if (typeof body.is_verified === 'boolean') {
      updates.push('is_verified = ?');
      params.push(body.is_verified ? 1 : 0);
      dbRun(`UPDATE users SET verified_flag = ? WHERE id = ?`, [body.is_verified ? 1 : 0, botId]);
    }
    if (body.assigned_chat_id !== undefined) {
      const nextChatId = body.assigned_chat_id ? String(body.assigned_chat_id).trim() : null;
      updates.push('assigned_chat_id = ?');
      params.push(nextChatId);

      // Clear previous assignment
      if (existing.assigned_chat_id && existing.assigned_chat_id !== nextChatId) {
        dbRun(`UPDATE chats SET assigned_bot_id = NULL WHERE id = ? AND assigned_bot_id = ?`, [
          existing.assigned_chat_id,
          botId,
        ]);
      }
      // Set new assignment
      if (nextChatId) {
        dbRun(`UPDATE chats SET assigned_bot_id = ? WHERE id = ?`, [botId, nextChatId]);
        dbRun(
          `INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at, last_read_at)
           VALUES (?, ?, 'member', datetime('now'), datetime('now'))`,
          [nextChatId, botId]
        );
      }
    }

    if (updates.length > 0) {
      params.push(botId);
      dbRun(`UPDATE bots SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    res.json({ ok: true });
  });

  // Admin: Bot Manager - Delete custom bot
  app.delete('/api/v1/admin/bots/:id', requireAuth, (req: AuthRequest, res) => {
    if (!req.authUser!.is_admin) {
      sendApiError(res, 403, 'FORBIDDEN', 'Administrator privileges required.');
      return;
    }
    const botId = String(req.params.id);
    if (botId === 'bot_zephyrix_ai') {
      sendApiError(res, 400, 'PROTECTED_BOT', 'Default Zephyrix AI Assistant cannot be deleted.');
      return;
    }

    withTx(() => {
      dbRun(`UPDATE chats SET assigned_bot_id = NULL WHERE assigned_bot_id = ?`, [botId]);
      dbRun(`DELETE FROM bots WHERE id = ?`, [botId]);
    });

    res.json({ ok: true });
  });
}

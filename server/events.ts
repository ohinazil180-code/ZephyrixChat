import type { Response } from 'express';
import { dbAll } from './db.ts';

export type LiveEventPayload =
  | { type: 'message:new'; chatId: string; message: unknown }
  | { type: 'message:updated'; chatId: string; message: unknown }
  | { type: 'message:deleted'; chatId: string; messageId: string }
  | { type: 'chat:updated'; chatId: string }
  | { type: 'typing'; chatId: string; userId: string; isTyping: boolean }
  | { type: 'read'; chatId: string; userId: string; readAt: string }
  | { type: 'presence'; userId: string; online: boolean; lastSeenAt: string }
  | {
      type: 'call:invite';
      callId: string;
      chatId: string;
      roomId: string;
      callType: 'audio' | 'video' | 'group';
      caller: { id: string; displayName: string; username: string; avatarUrl: string | null };
    }
  | { type: 'call:ended'; callId: string; chatId: string; reason: string };

const userStreams = new Map<string, Set<Response>>();

export function addEventStream(userId: string, res: Response): void {
  let set = userStreams.get(userId);
  if (!set) {
    set = new Set();
    userStreams.set(userId, set);
  }
  set.add(res);
}

export function removeEventStream(userId: string, res: Response): void {
  const set = userStreams.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    userStreams.delete(userId);
  }
}

export function isUserConnectedSse(userId: string): boolean {
  const set = userStreams.get(userId);
  return Boolean(set && set.size > 0);
}

export function publishToUsers(userIds: string[], event: LiveEventPayload): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const uid of new Set(userIds)) {
    const sockets = userStreams.get(uid);
    if (!sockets) continue;
    for (const res of sockets) {
      try {
        res.write(frame);
      } catch {
        // Ignore broken SSE pipe; close handler cleans up
      }
    }
  }
}

export function publishToChat(chatId: string, event: LiveEventPayload, excludeUserId?: string): void {
  const rows = dbAll<{ user_id: string }>(
    `SELECT user_id FROM chat_members WHERE chat_id = ? AND left_at IS NULL`,
    [chatId]
  );
  const targets = rows.map((r) => r.user_id).filter((id) => id !== excludeUserId);
  publishToUsers(targets, event);
}

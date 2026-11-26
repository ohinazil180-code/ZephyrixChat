import type { Response } from 'express';
import { WebSocket } from 'ws';
import { dbAll } from './db.ts';

export interface ReactionUserSummary {
  id: string;
  displayName: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  users: ReactionUserSummary[];
}

export type LiveEventPayload =
  | { type: 'message:new'; chatId: string; message: unknown }
  | { type: 'message:updated'; chatId: string; message: unknown }
  | { type: 'message:deleted'; chatId: string; messageId: string }
  | { type: 'message:hidden'; chatId: string; messageIds: string[] }
  | {
      type: 'message:reaction';
      chatId: string;
      messageId: string;
      actorUserId: string;
      emoji: string;
      action: 'added' | 'removed';
      reactions: ReactionSummary[];
    }
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
const userWebSockets = new Map<string, Set<WebSocket>>();

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

export function addWebSocketClient(userId: string, ws: WebSocket): void {
  let set = userWebSockets.get(userId);
  if (!set) {
    set = new Set();
    userWebSockets.set(userId, set);
  }
  set.add(ws);
}

export function removeWebSocketClient(userId: string, ws: WebSocket): void {
  const set = userWebSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    userWebSockets.delete(userId);
  }
}

export function isUserConnectedSse(userId: string): boolean {
  const sse = userStreams.get(userId);
  const ws = userWebSockets.get(userId);
  return Boolean((sse && sse.size > 0) || (ws && ws.size > 0));
}

export function publishToUsers(userIds: string[], event: LiveEventPayload): void {
  const json = JSON.stringify(event);
  const sseFrame = `data: ${json}\n\n`;
  for (const uid of new Set(userIds)) {
    const sseSockets = userStreams.get(uid);
    if (sseSockets) {
      for (const res of sseSockets) {
        try {
          res.write(sseFrame);
        } catch {
          // Ignore broken SSE pipe; close handler cleans up
        }
      }
    }

    const wsSockets = userWebSockets.get(uid);
    if (wsSockets) {
      for (const ws of wsSockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(json);
          } catch {
            // Ignore closed socket
          }
        }
      }
    }
  }
}

export async function publishToChat(chatId: string, event: LiveEventPayload, excludeUserId?: string): Promise<void> {
  const rows = await dbAll<{ user_id: string }>(
    `SELECT user_id FROM chat_members WHERE chat_id = ? AND left_at IS NULL`,
    [chatId]
  );
  const targets = rows.map((r) => r.user_id).filter((id) => id !== excludeUserId);
  publishToUsers(targets, event);
}

export async function publishReactionToChat(
  chatId: string,
  messageId: string,
  actorUserId: string,
  emoji: string,
  action: 'added' | 'removed',
  groupedReactions: Array<{ emoji: string; count: number; userIds: Set<string>; users: ReactionUserSummary[] }>
): Promise<void> {
  const rows = await dbAll<{ user_id: string }>(
    `SELECT user_id FROM chat_members WHERE chat_id = ? AND left_at IS NULL`,
    [chatId]
  );
  for (const row of rows) {
    const uid = row.user_id;
    const viewerReactions: ReactionSummary[] = groupedReactions.map((g) => ({
      emoji: g.emoji,
      count: g.count,
      reactedByMe: g.userIds.has(uid),
      users: g.users,
    }));
    publishToUsers([uid], {
      type: 'message:reaction',
      chatId,
      messageId,
      actorUserId,
      emoji,
      action,
      reactions: viewerReactions,
    });
  }
}

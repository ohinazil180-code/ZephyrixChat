import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ZIM,
  ZIMConnectionState,
  ZIMConversationType,
  ZIMMessagePriority,
  ZIMMessageReceiptStatus,
  ZIMMessageType,
  ZIMUserOnlineStatus,
  type ZIMAudioMessage,
  type ZIMCommandMessage,
  type ZIMCustomMessage,
} from 'zego-zim-web';
import { apiFetch } from '../lib/api';
import type { ChatMessage, UserProfile } from '../types/zephyrix';

export interface ZimTokenResponse {
  appID: number;
  userID: string;
  userName: string;
  token: string;
  expiresAt: number;
}

export interface UseZimCallbacks {
  onPeerMessage: (msg: ChatMessage) => void;
  onTypingSignal: (chatId: string, userId: string, isTyping: boolean) => void;
  onPeerReadReceipt: (peerUserId: string) => void;
  onPresenceUpdate: (userId: string, online: boolean, lastSeenAt: string) => void;
}

export type ZimStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected';

export function useZim(
  user: UserProfile | null,
  zegoConfigured: boolean,
  peerIdsToSubscribe: string[],
  callbacks: UseZimCallbacks
) {
  const [status, setStatus] = useState<ZimStatus>(zegoConfigured ? 'disconnected' : 'unconfigured');
  const zimRef = useRef<ZIM | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!user || !user.username || !zegoConfigured) {
      setStatus(zegoConfigured ? 'disconnected' : 'unconfigured');
      return;
    }

    let cancelled = false;
    let instance: ZIM | null = null;

    const connectZim = async () => {
      setStatus('connecting');
      try {
        const tokenResp = await apiFetch<ZimTokenResponse>('/api/v1/zego/token', { method: 'POST' });
        if (cancelled) return;

        instance = ZIM.getInstance() || ZIM.create({ appID: tokenResp.appID });
        if (!instance) {
          setStatus('unconfigured');
          return;
        }
        zimRef.current = instance;

        instance.on('connectionStateChanged', (_zim, data) => {
          if (data.state === ZIMConnectionState.Connected) setStatus('connected');
          else if (data.state === ZIMConnectionState.Connecting || data.state === ZIMConnectionState.Reconnecting) {
            setStatus('connecting');
          } else {
            setStatus('disconnected');
          }
        });

        instance.on('tokenWillExpire', async (zim) => {
          try {
            const refreshed = await apiFetch<ZimTokenResponse>('/api/v1/zego/token', { method: 'POST' });
            await zim.renewToken(refreshed.token);
          } catch {
            // Retry on next connection cycle
          }
        });

        instance.on('peerMessageReceived', (_zim, { messageList, fromConversationID }) => {
          const decoder = new TextDecoder();
          for (const rawMsg of messageList) {
            if (rawMsg.type === ZIMMessageType.Command) {
              try {
                const cmd = rawMsg as ZIMCommandMessage;
                const parsed = JSON.parse(decoder.decode(cmd.message)) as {
                  kind?: string;
                  chatId?: string;
                  isTyping?: boolean;
                };
                if (parsed.kind === 'typing' && parsed.chatId) {
                  callbacksRef.current.onTypingSignal(
                    parsed.chatId,
                    fromConversationID,
                    Boolean(parsed.isTyping)
                  );
                }
              } catch {
                // ignore malformed command
              }
            } else if (rawMsg.type === ZIMMessageType.Custom) {
              try {
                const custom = rawMsg as ZIMCustomMessage;
                if (custom.subType === 1) {
                  const payload = JSON.parse(custom.message) as ChatMessage;
                  callbacksRef.current.onPeerMessage(payload);
                }
              } catch {
                // ignore malformed custom payload
              }
            } else if (rawMsg.type === ZIMMessageType.Audio) {
              const audio = rawMsg as ZIMAudioMessage;
              try {
                const meta = audio.extendedData
                  ? (JSON.parse(audio.extendedData) as Partial<ChatMessage>)
                  : {};
                if (meta.chatId) {
                  const voiceMsg: ChatMessage = {
                    id: meta.id || String(audio.messageID),
                    clientId: meta.clientId || null,
                    chatId: meta.chatId,
                    senderId: fromConversationID,
                    senderName: meta.senderName || 'Contact',
                    senderUsername: meta.senderUsername || null,
                    senderAvatar: meta.senderAvatar || null,
                    senderVerified: Boolean(meta.senderVerified),
                    body: '',
                    deletedAt: null,
                    createdAt: meta.createdAt || new Date(audio.timestamp || Date.now()).toISOString(),
                    attachments: [
                      {
                        storageKey: audio.fileDownloadUrl || '',
                        url: audio.fileDownloadUrl || '',
                        originalName: audio.fileName || 'voice-note.webm',
                        mimeType: 'audio/webm',
                        kind: 'voice',
                        sizeBytes: audio.fileSize || 0,
                        durationMs: (audio.audioDuration || 1) * 1000,
                      },
                    ],
                    status: 'delivered',
                  };
                  callbacksRef.current.onPeerMessage(voiceMsg);
                }
              } catch {
                // ignore
              }
            }
          }
        });

        instance.on('messageReceiptChanged', (_zim, { infos }) => {
          for (const info of infos) {
            if (info.conversationType === ZIMConversationType.Peer && info.status === ZIMMessageReceiptStatus.Done) {
              callbacksRef.current.onPeerReadReceipt(info.conversationID);
            }
          }
        });

        instance.on('conversationMessageReceiptChanged', (_zim, { infos }) => {
          for (const info of infos) {
            if (info.conversationType === ZIMConversationType.Peer) {
              callbacksRef.current.onPeerReadReceipt(info.conversationID);
            }
          }
        });

        instance.on('userStatusUpdated', (_zim, { userStatusList }) => {
          for (const st of userStatusList) {
            const isOnline = st.onlineStatus === ZIMUserOnlineStatus.Online;
            const lastSeenIso =
              st.lastUpdateTime > 0 ? new Date(st.lastUpdateTime).toISOString() : new Date().toISOString();
            callbacksRef.current.onPresenceUpdate(st.userID, isOnline, lastSeenIso);
          }
        });

        await instance.login(tokenResp.userID, {
          userName: tokenResp.userName,
          token: tokenResp.token,
          isOfflineLogin: false,
          customStatus: '',
          customStatusDuration: 0,
        });
        if (!cancelled) {
          setStatus('connected');
        }
      } catch (err) {
        console.warn('[zim] Connection skipped/failed:', err instanceof Error ? err.message : err);
        if (!cancelled) {
          setStatus('disconnected');
        }
      }
    };

    void connectZim();

    return () => {
      cancelled = true;
      const z = zimRef.current;
      zimRef.current = null;
      if (z) {
        try {
          z.logout();
        } catch {
          // ignore
        }
        z.destroy();
      }
    };
  }, [user?.id, user?.username, zegoConfigured]);

  useEffect(() => {
    const zim = zimRef.current;
    if (!zim || status !== 'connected' || peerIdsToSubscribe.length === 0) return;

    const batch = peerIdsToSubscribe.slice(0, 100);
    zim.subscribeUsersStatus(batch, { subscriptionDuration: 60 }).catch(() => {});
  }, [status, peerIdsToSubscribe.join(',')]);

  const sendTypingSignal = useCallback(
    (peerId: string | undefined, chatId: string, isTyping: boolean) => {
      const zim = zimRef.current;
      if (!zim || !peerId || status !== 'connected') return;

      const encoder = new TextEncoder();
      const cmdMessage = {
        type: ZIMMessageType.Command,
        message: encoder.encode(JSON.stringify({ kind: 'typing', chatId, isTyping })),
      } as ZIMCommandMessage;

      zim
        .sendMessage(cmdMessage, peerId, ZIMConversationType.Peer, {
          priority: ZIMMessagePriority.Low,
        })
        .catch(() => {});
    },
    [status]
  );

  const sendRealtimeMessage = useCallback(
    async (peerId: string | undefined, payload: ChatMessage) => {
      const zim = zimRef.current;
      if (!zim || !peerId || status !== 'connected') return;

      const customMsg = {
        type: ZIMMessageType.Custom,
        subType: 1,
        searchedContent: payload.body.slice(0, 200),
        message: JSON.stringify(payload),
      } as ZIMCustomMessage;

      await zim.sendMessage(customMsg, peerId, ZIMConversationType.Peer, {
        priority: ZIMMessagePriority.Medium,
        hasReceipt: true,
      });
    },
    [status]
  );

  const markPeerRead = useCallback(
    (peerId: string | undefined) => {
      const zim = zimRef.current;
      if (!zim || !peerId || status !== 'connected') return;
      zim.sendConversationMessageReceiptRead(peerId, ZIMConversationType.Peer).catch(() => {});
    },
    [status]
  );

  return {
    zimStatus: status,
    sendTypingSignal,
    sendRealtimeMessage,
    markPeerRead,
  };
}

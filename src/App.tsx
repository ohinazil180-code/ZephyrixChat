/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AuthScreen } from './components/AuthScreen';
import { CallOverlay } from './components/CallOverlay';
import { ChatStage } from './components/ChatStage';
import { InfoDrawer } from './components/InfoDrawer';
import { MediaLightbox } from './components/MediaLightbox';
import { OfflineIndicator } from './components/OfflineIndicator';
import { AdminPanel } from './components/AdminPanel';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { SplashScreen } from './components/SplashScreen';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useZim } from './hooks/useZim';
import {
  apiFetch,
  apiUrl,
  fetchSystemConfig,
  getOfflineOutbox,
  removeOfflineMessage,
  setInMemoryToken,
  wsUrl,
} from './lib/api';
import type {
  ActiveCallSession,
  ChatMessage,
  ChatSummary,
  IncomingCallInvite,
  Locale,
  MessageAttachment,
  MessageReaction,
  PendingDirectReply,
  SystemConfig,
  ThemeMode,
  UserProfile,
} from './types/zephyrix';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem('zephyrix_locale');
    return saved === 'bn' ? 'bn' : 'en';
  });
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('zephyrix_theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [rtlPreview, setRtlPreview] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(() => {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>({});
  const [typingByChat, setTypingByChat] = useState<Record<string, string[]>>({});
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [lightboxAtt, setLightboxAtt] = useState<MessageAttachment | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');

  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInvite | null>(null);
  const [pendingDirectReply, setPendingDirectReply] = useState<PendingDirectReply | null>(null);

  const isOnline = useOnlineStatus();
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('zephyrix_theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem('zephyrix_locale', locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dir = rtlPreview ? 'rtl' : 'ltr';
  }, [rtlPreview]);

  useEffect(() => {
    const root = document.documentElement;
    if (reduceMotion) root.classList.add('reduce-motion');
    else root.classList.remove('reduce-motion');
  }, [reduceMotion]);

  const loadChats = useCallback(async (selectId?: string) => {
    try {
      const res = await apiFetch<{ chats: ChatSummary[] }>('/api/v1/chats');
      setChats(res.chats);
      if (selectId) {
        setActiveChatId(selectId);
        setMobileView('chat');
      } else if (!activeChatIdRef.current && res.chats.length > 0) {
        setActiveChatId(res.chats[0].id);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    try {
      const res = await apiFetch<{ messages: ChatMessage[] }>(`/api/v1/chats/${chatId}/messages?limit=80`);
      setMessagesByChat((prev) => ({ ...prev, [chatId]: res.messages }));
      await apiFetch(`/api/v1/chats/${chatId}/read`, { method: 'POST' }).catch(() => {});
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)));
    } catch {
      // ignore
    }
  }, []);

  // Boot check with crisp 750ms splash screen timing
  useEffect(() => {
    const minSplash = new Promise((r) => window.setTimeout(r, 750));
    Promise.all([
      minSplash,
      fetchSystemConfig().catch(() => null),
      apiFetch<{ user: UserProfile }>('/api/v1/me').catch(() => null),
    ])
      .then(([, cfg, me]) => {
        if (cfg) setSystemConfig(cfg);
        if (me?.user) {
          setUser(me.user);
          if (me.user.preferred_locale === 'bn' || me.user.preferred_locale === 'en') {
            setLocale(me.user.preferred_locale);
          }
        }
      })
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (user) {
      void loadChats();
    }
  }, [user, loadChats]);

  // Real-Time WebSocket + Server-Sent Events (instant sync across direct, groups, channels, reactions & call invites)
  useEffect(() => {
    if (!user) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 1000;

    const handleLiveEvent = (rawData: string) => {
      try {
        const evt = JSON.parse(rawData) as {
          type: string;
          chatId?: string;
          message?: ChatMessage;
          messageId?: string;
          reactions?: MessageReaction[];
          userId?: string;
          isTyping?: boolean;
          callId?: string;
          roomId?: string;
          callType?: 'audio' | 'video' | 'group';
          caller?: IncomingCallInvite['caller'];
        };

        if (evt.type === 'message:new' && evt.message && evt.chatId) {
          const msg = evt.message;
          setMessagesByChat((prev) => {
            const list = prev[msg.chatId] || [];
            if (list.some((m) => m.id === msg.id)) return prev;
            return { ...prev, [msg.chatId]: [...list, msg] };
          });
          if (activeChatIdRef.current === evt.chatId) {
            void apiFetch(`/api/v1/chats/${evt.chatId}/read`, { method: 'POST' }).catch(() => {});
          }
          void loadChats();
        } else if (evt.type === 'message:updated' && evt.message && evt.chatId) {
          const updated = evt.message;
          setMessagesByChat((prev) => ({
            ...prev,
            [updated.chatId]: (prev[updated.chatId] || []).map((m) =>
              m.id === updated.id ? updated : m
            ),
          }));
          void loadChats();
        } else if (evt.type === 'message:reaction' && evt.chatId && evt.messageId && Array.isArray(evt.reactions)) {
          const nextReactions = evt.reactions;
          const targetChatId = evt.chatId;
          const targetMessageId = evt.messageId;
          setMessagesByChat((prev) => {
            const list = prev[targetChatId];
            if (!list) return prev;
            return {
              ...prev,
              [targetChatId]: list.map((m) =>
                m.id === targetMessageId ? { ...m, reactions: nextReactions } : m
              ),
            };
          });
        } else if (evt.type === 'message:deleted' && evt.chatId && evt.messageId) {
          setMessagesByChat((prev) => ({
            ...prev,
            [evt.chatId!]: (prev[evt.chatId!] || []).map((m) =>
              m.id === evt.messageId
                ? { ...m, deletedAt: new Date().toISOString(), body: '', attachments: [], reactions: [] }
                : m
            ),
          }));
          void loadChats();
        } else if (evt.type === 'chat:updated') {
          void loadChats();
        } else if (evt.type === 'typing' && evt.chatId && evt.userId) {
          setTypingByChat((prev) => {
            const cur = new Set(prev[evt.chatId!] || []);
            if (evt.isTyping) cur.add(evt.userId!);
            else cur.delete(evt.userId!);
            return { ...prev, [evt.chatId!]: Array.from(cur) };
          });
        } else if (evt.type === 'read' && evt.chatId && evt.userId && evt.userId !== user.id) {
          setMessagesByChat((prev) => ({
            ...prev,
            [evt.chatId!]: (prev[evt.chatId!] || []).map((m) =>
              m.senderId === user.id ? { ...m, status: 'read' } : m
            ),
          }));
        } else if (evt.type === 'call:invite' && evt.callId && evt.chatId && evt.roomId && evt.caller) {
          setIncomingCall({
            callId: evt.callId,
            chatId: evt.chatId,
            roomId: evt.roomId,
            callType: evt.callType || 'video',
            caller: evt.caller,
          });
        } else if (evt.type === 'call:ended' && evt.callId) {
          setIncomingCall((cur) => (cur?.callId === evt.callId ? null : cur));
        }
      } catch {
        // ignore malformed event frames
      }
    };

    const connectWs = () => {
      if (closed) return;
      try {
        const socket = new WebSocket(wsUrl('/api/v1/ws'));
        ws = socket;
        socket.onopen = () => {
          reconnectDelay = 1000;
        };
        socket.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            handleLiveEvent(ev.data);
          }
        };
        socket.onclose = () => {
          if (closed) return;
          reconnectTimer = window.setTimeout(() => {
            reconnectDelay = Math.min(15000, reconnectDelay * 2);
            connectWs();
          }, reconnectDelay);
        };
        socket.onerror = () => {
          socket.close();
        };
      } catch {
        // SSE remains active as fallback
      }
    };

    connectWs();

    const es = new EventSource(apiUrl('/api/v1/events'), { withCredentials: true });
    es.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        handleLiveEvent(ev.data);
      }
    };

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (ws) ws.close();
      es.close();
    };
  }, [user?.id, loadChats]);

  const peerIdsToSubscribe = useMemo(
    () =>
      chats
        .map((c) => c.peer?.id)
        .filter((id): id is string => Boolean(id)),
    [chats]
  );

  const {
    zimStatus,
    sendTypingSignal,
    sendRealtimeMessage,
    markPeerRead,
  } = useZim(user, Boolean(systemConfig?.zegoConfigured), peerIdsToSubscribe, {
    onPeerMessage: (msg) => {
      setMessagesByChat((prev) => {
        const list = prev[msg.chatId] || [];
        if (list.some((m) => m.id === msg.id)) return prev;
        if (msg.clientId && list.some((m) => m.clientId === msg.clientId)) {
          return {
            ...prev,
            [msg.chatId]: list.map((m) => (m.clientId === msg.clientId ? msg : m)),
          };
        }
        return { ...prev, [msg.chatId]: [...list, msg] };
      });
      if (activeChatIdRef.current === msg.chatId) {
        markPeerRead(msg.senderId);
        void apiFetch(`/api/v1/chats/${msg.chatId}/read`, { method: 'POST' }).catch(() => {});
      }
      void loadChats();
    },
    onTypingSignal: (chatId, userId, isTyping) => {
      setTypingByChat((prev) => {
        const cur = new Set(prev[chatId] || []);
        if (isTyping) cur.add(userId);
        else cur.delete(userId);
        return { ...prev, [chatId]: Array.from(cur) };
      });
    },
    onPeerReadReceipt: (peerUserId) => {
      setChats((currentChats) => {
        const matched = currentChats.find((c) => c.peer?.id === peerUserId);
        if (matched) {
          setMessagesByChat((prev) => ({
            ...prev,
            [matched.id]: (prev[matched.id] || []).map((m) =>
              m.senderId === user?.id ? { ...m, status: 'read' } : m
            ),
          }));
        }
        return currentChats;
      });
    },
    onPresenceUpdate: (userId, online, lastSeenAt) => {
      setChats((prev) =>
        prev.map((c) =>
          c.peer && c.peer.id === userId
            ? { ...c, peer: { ...c.peer, online, lastSeenAt } }
            : c
        )
      );
    },
  });

  useEffect(() => {
    if (activeChatId && user) {
      void loadMessages(activeChatId);
      const chat = chats.find((c) => c.id === activeChatId);
      if (chat?.peer?.id) {
        markPeerRead(chat.peer.id);
      }
    }
  }, [activeChatId, user?.id, loadMessages]);

  // Flush offline outbox when reconnected
  useEffect(() => {
    if (!isOnline || !user) return;
    const queued = getOfflineOutbox();
    if (queued.length === 0) return;

    (async () => {
      for (const draft of queued) {
        try {
          const res = await apiFetch<{ message: ChatMessage }>(`/api/v1/chats/${draft.chatId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              clientId: draft.clientId,
              body: draft.body,
            }),
          });
          removeOfflineMessage(draft.clientId);
          if (draft.peerId) {
            await sendRealtimeMessage(draft.peerId, res.message).catch(() => {});
          }
          setMessagesByChat((prev) => {
            const list = prev[draft.chatId] || [];
            const exists = list.some((m) => m.id === res.message.id || m.clientId === draft.clientId);
            return {
              ...prev,
              [draft.chatId]: exists
                ? list.map((m) => (m.clientId === draft.clientId || m.id === res.message.id ? res.message : m))
                : [...list, res.message],
            };
          });
        } catch {
          // keep in outbox
        }
      }
      void loadChats();
    })();
  }, [isOnline, user?.id, loadChats, sendRealtimeMessage]);

  const handleStartCall = async (callType: 'audio' | 'video' | 'group') => {
    if (!activeChat) return;
    try {
      const res = await apiFetch<{ callId: string; chatId: string; roomId: string; callType: 'audio' | 'video' | 'group' }>(
        '/api/v1/calls',
        {
          method: 'POST',
          body: JSON.stringify({ chatId: activeChat.id, callType }),
        }
      );
      setActiveCall({
        callId: res.callId,
        chatId: res.chatId,
        roomId: res.roomId,
        title: activeChat.title,
        callType: res.callType,
        isGroup: activeChat.type === 'group' || callType === 'group',
      });
    } catch {
      setActiveCall({
        callId: crypto.randomUUID(),
        chatId: activeChat.id,
        roomId: activeChat.zegoRoomId,
        title: activeChat.title,
        callType,
        isGroup: activeChat.type === 'group' || callType === 'group',
      });
    }
  };

  const handleAcceptIncomingCall = (invite: IncomingCallInvite) => {
    setIncomingCall(null);
    const matchedChat = chats.find((c) => c.id === invite.chatId);
    setActiveCall({
      callId: invite.callId,
      chatId: invite.chatId,
      roomId: invite.roomId,
      title: matchedChat?.title || invite.caller.displayName,
      callType: invite.callType,
      isGroup: matchedChat?.type === 'group' || invite.callType === 'group',
    });
  };

  const handleDeclineIncomingCall = (invite: IncomingCallInvite) => {
    setIncomingCall(null);
    void apiFetch(`/api/v1/calls/${invite.callId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'declined' }),
    }).catch(() => {});
  };

  const handleEndActiveCall = () => {
    if (activeCall) {
      void apiFetch(`/api/v1/calls/${activeCall.callId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'ended' }),
      }).catch(() => {});
    }
    setActiveCall(null);
  };

  const handleMessageOptimistic = (msg: ChatMessage) => {
    setMessagesByChat((prev) => ({
      ...prev,
      [msg.chatId]: [...(prev[msg.chatId] || []), msg],
    }));
  };

  const handleMessageConfirmed = (clientId: string, confirmed: ChatMessage) => {
    setMessagesByChat((prev) => {
      const list = prev[confirmed.chatId] || [];
      const hasConfirmed = list.some((m) => m.id === confirmed.id);
      if (hasConfirmed) {
        return {
          ...prev,
          [confirmed.chatId]: list.filter((m) => m.id !== clientId),
        };
      }
      return {
        ...prev,
        [confirmed.chatId]: list.map((m) => (m.clientId === clientId ? confirmed : m)),
      };
    });
    void loadChats();
  };

  const handleMessageUpdated = (updated: ChatMessage) => {
    setMessagesByChat((prev) => ({
      ...prev,
      [updated.chatId]: (prev[updated.chatId] || []).map((m) => (m.id === updated.id ? updated : m)),
    }));
    void loadChats();
  };

  const handleMessageDeleted = (chatId: string, messageId: string) => {
    setMessagesByChat((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] || []).map((m) =>
        m.id === messageId
          ? { ...m, deletedAt: new Date().toISOString(), body: '', attachments: [], reactions: [] }
          : m
      ),
    }));
    void loadChats();
  };

  const handleReplyPrivately = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.senderId || msg.senderId === user?.id || msg.isBot || String(msg.senderId).startsWith('bot_')) {
        return;
      }
      try {
        const res = await apiFetch<{ chat: ChatSummary }>('/api/v1/chats', {
          method: 'POST',
          body: JSON.stringify({ type: 'direct', targetUserId: msg.senderId }),
        });
        if (!res.chat?.id) return;
        const previewBody =
          msg.body?.trim() ||
          msg.attachments?.[0]?.originalName ||
          (msg.attachments?.[0]?.kind ? `${msg.attachments[0].kind} attachment` : 'Attachment');
        const quoteText = `${msg.senderName}: ${previewBody}`.slice(0, 380);
        setPendingDirectReply({
          chatId: res.chat.id,
          senderName: msg.senderName,
          previewBody,
          quoteText,
        });
        await loadChats(res.chat.id);
      } catch {
        // ignore if user cannot be messaged
      }
    },
    [loadChats, user?.id]
  );

  const handleUpdateChatPref = useCallback(
    async (chat: ChatSummary, patch: { pinned?: boolean; muted?: boolean; archived?: boolean }) => {
      const now = new Date().toISOString();
      const snapshot = chats;

      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chat.id) return c;
          return {
            ...c,
            pinnedAt: patch.pinned !== undefined ? (patch.pinned ? now : null) : c.pinnedAt,
            archivedAt: patch.archived !== undefined ? (patch.archived ? now : null) : c.archivedAt,
            mutedUntil:
              patch.muted !== undefined
                ? patch.muted
                  ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                  : null
                : c.mutedUntil,
          };
        });
        next.sort((a, b) => {
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
        return next;
      });

      try {
        await apiFetch(`/api/v1/chats/${chat.id}/preferences`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        void loadChats();
      } catch {
        setChats(snapshot);
      }
    },
    [chats, loadChats]
  );

  const handleLoggedOut = () => {
    setInMemoryToken(null);
    setUser(null);
    setChats([]);
    setActiveChatId(null);
    setMessagesByChat({});
    setSettingsOpen(false);
    setInfoOpen(false);
    setActiveCall(null);
    setIncomingCall(null);
  };

  const activeChat = chats.find((c) => c.id === activeChatId) || null;
  const activeMessages = activeChat ? messagesByChat[activeChat.id] || [] : [];

  return (
    <>
      <AnimatePresence>
        {booting && <SplashScreen key="splash" locale={locale} reduceMotion={reduceMotion} />}
      </AnimatePresence>

      {!booting && !user && (
        <motion.div
          key="auth-view"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          <AuthScreen
            locale={locale}
            onLocaleChange={setLocale}
            theme={theme}
            onThemeChange={setTheme}
            reduceMotion={reduceMotion}
            onAuthenticated={(u) => {
              setUser(u);
              if (u.preferred_locale === 'bn' || u.preferred_locale === 'en') {
                setLocale(u.preferred_locale);
              }
            }}
          />
          <OfflineIndicator locale={locale} />
        </motion.div>
      )}

      {!booting && user && (
        <motion.div
          key="dashboard-view"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.26, ease: [0.16, 1, 0.3, 1] }}
          className="h-screen w-screen overflow-hidden flex bg-[#F5F7FB] dark:bg-[#0B101B] text-slate-900 dark:text-slate-100"
        >
          <div className={`${mobileView === 'chat' ? 'hidden md:flex' : 'flex'} w-full md:w-auto h-full`}>
        <Sidebar
          locale={locale}
          onLocaleChange={setLocale}
          theme={theme}
          onThemeChange={setTheme}
          user={user}
          chats={chats}
          activeChatId={activeChatId}
          typingByChat={typingByChat}
          onSelectChat={(id) => {
            setActiveChatId(id);
            setMobileView('chat');
          }}
          onUpdateChatPref={handleUpdateChatPref}
          onOpenSettings={() => setSettingsOpen(true)}
          onChatsChanged={(id) => void loadChats(id)}
        />
      </div>

      <main className={`${mobileView === 'list' ? 'hidden md:flex' : 'flex'} flex-1 h-full min-w-0`}>
        <ChatStage
          locale={locale}
          user={user}
          chat={activeChat}
          allChats={chats}
          messages={activeMessages}
          typingUserIds={activeChat ? typingByChat[activeChat.id] || [] : []}
          reduceMotion={reduceMotion}
          zimStatus={zimStatus}
          onBackMobile={() => setMobileView('list')}
          onOpenInfo={() => setInfoOpen((o) => !o)}
          onStartCall={(ct) => void handleStartCall(ct)}
          onTyping={sendTypingSignal}
          onRealtimeSend={sendRealtimeMessage}
          onMessageOptimistic={handleMessageOptimistic}
          onMessageConfirmed={handleMessageConfirmed}
          onMessageUpdated={handleMessageUpdated}
          onMessageDeleted={handleMessageDeleted}
          onOpenLightbox={(att) => setLightboxAtt(att)}
          pendingDirectReply={pendingDirectReply}
          onClearPendingDirectReply={() => setPendingDirectReply(null)}
          onReplyPrivately={(msg) => void handleReplyPrivately(msg)}
          onRefreshChats={() => void loadChats()}
        />

        {infoOpen && activeChat && (
          <div className="fixed inset-0 z-40 lg:static lg:z-auto flex justify-end bg-black/40 lg:bg-transparent">
            <InfoDrawer
              locale={locale}
              currentUser={user}
              chat={activeChat}
              messages={activeMessages}
              onClose={() => setInfoOpen(false)}
              onRefreshChats={() => void loadChats()}
              onOpenLightbox={(att) => setLightboxAtt(att)}
            />
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        user={user}
        onUserUpdated={(updated) => setUser(updated)}
        onLoggedOut={handleLoggedOut}
        locale={locale}
        onLocaleChange={setLocale}
        theme={theme}
        onThemeChange={setTheme}
        rtlPreview={rtlPreview}
        onRtlPreviewChange={setRtlPreview}
        reduceMotion={reduceMotion}
        onReduceMotionChange={setReduceMotion}
        onOpenAdminPanel={() => setAdminPanelOpen(true)}
      />

      <AdminPanel
        open={adminPanelOpen}
        onClose={() => setAdminPanelOpen(false)}
        locale={locale}
        currentUser={user}
      />

      <CallOverlay
        locale={locale}
        user={user}
        zegoConfigured={Boolean(systemConfig?.zegoConfigured)}
        activeCall={activeCall}
        incomingCall={incomingCall}
        onAcceptIncoming={handleAcceptIncomingCall}
        onDeclineIncoming={handleDeclineIncomingCall}
        onEndCall={handleEndActiveCall}
      />

      <MediaLightbox attachment={lightboxAtt} onClose={() => setLightboxAtt(null)} />
      <OfflineIndicator locale={locale} />
        </motion.div>
      )}
    </>
  );
}

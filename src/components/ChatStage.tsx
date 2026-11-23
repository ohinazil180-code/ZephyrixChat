import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BellOff,
  Bot,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Download,
  FileText,
  Forward,
  Info,
  Mic,
  MoreVertical,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  Pin,
  Play,
  Send,
  Smile,
  Square,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import type { ZimStatus } from '../hooks/useZim';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { formatBytes, formatDateDivider, formatTime, translations } from '../i18n/translations';
import {
  ApiError,
  apiFetch,
  enqueueOfflineMessage,
  uploadMediaFile,
} from '../lib/api';
import type {
  ChatMessage,
  ChatSummary,
  Locale,
  MessageAttachment,
  UserProfile,
} from '../types/zephyrix';
import { Avatar } from './Avatar';
import { BotBadge, DeveloperBadge, VerifiedBadge } from './Badges';

interface ChatStageProps {
  locale: Locale;
  user: UserProfile;
  chat: ChatSummary | null;
  allChats: ChatSummary[];
  messages: ChatMessage[];
  typingUserIds: string[];
  reduceMotion: boolean;
  zimStatus: ZimStatus;
  onBackMobile: () => void;
  onOpenInfo: () => void;
  onStartCall: (callType: 'audio' | 'video' | 'group') => void;
  onTyping: (peerId: string | undefined, chatId: string, isTyping: boolean) => void;
  onRealtimeSend: (peerId: string | undefined, message: ChatMessage) => Promise<void>;
  onMessageOptimistic: (msg: ChatMessage) => void;
  onMessageConfirmed: (clientId: string, msg: ChatMessage) => void;
  onMessageUpdated: (msg: ChatMessage) => void;
  onMessageDeleted: (chatId: string, messageId: string) => void;
  onOpenLightbox: (att: MessageAttachment) => void;
}

const REACTION_CHOICES = ['👍', '❤️', '🔥', '😂', '👏'];

const VoiceNotePlayer: React.FC<{ attachment: MessageAttachment }> = ({ attachment }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play();
  };

  const totalSec = Math.max(1, Math.round((attachment.durationMs || 1000) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');

  return (
    <div className="flex items-center gap-3 min-w-[215px] py-1">
      <audio
        ref={audioRef}
        src={attachment.url}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.duration) setProgress((el.currentTime / el.duration) * 100);
        }}
      />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        className="w-11 h-11 rounded-full bg-indigo-600 text-white flex items-center justify-center shrink-0 hover:bg-indigo-500 transition-colors"
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ms-0.5" />}
      </button>
      <div className="flex-1 space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-slate-300/40 dark:bg-white/15 overflow-hidden">
          <div className="h-full bg-sky-400 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex items-center justify-between text-[11px] font-mono-tabular opacity-80">
          <span>{mm}:{ss}</span>
          <span>{formatBytes(attachment.sizeBytes)}</span>
        </div>
      </div>
    </div>
  );
};

export const ChatStage: React.FC<ChatStageProps> = ({
  locale,
  user,
  chat,
  allChats,
  messages,
  typingUserIds,
  reduceMotion,
  zimStatus,
  onBackMobile,
  onOpenInfo,
  onStartCall,
  onTyping,
  onRealtimeSend,
  onMessageOptimistic,
  onMessageConfirmed,
  onMessageUpdated,
  onMessageDeleted,
  onOpenLightbox,
}) => {
  const t = translations[locale];
  const isOnline = useOnlineStatus();
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [body, setBody] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isSilent, setIsSilent] = useState(false);

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<ChatMessage | null>(null);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef<number>(0);

  const typingTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [chat?.id, messages.length, reduceMotion]);

  useEffect(() => {
    setReplyTo(null);
    setEditingMsg(null);
    setMenuMsgId(null);
    setComposerError(null);
    setPendingAttachments([]);
    setBody('');
  }, [chat?.id]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordStartRef.current) / 1000);
      setRecordSeconds(elapsed);
      if (elapsed >= 300) {
        stopVoiceRecording(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  if (!chat) {
    return (
      <div className="hidden md:flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] p-10 max-w-md space-y-4 shadow-xl">
          <img src="/icon.svg" alt="Zephyrix" className="w-14 h-14 mx-auto rounded-2xl shadow-md" />
          <h2 className="font-display text-2xl font-bold text-balance">{t.noChatsTitle}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{t.noChatsSubtitle}</p>
        </div>
      </div>
    );
  }

  const peerId = chat.peer?.id;
  const isChannelReadOnly = chat.type === 'channel' && chat.myRole !== 'owner' && chat.myRole !== 'admin';
  const canPost = !chat.isBlockedByMe && !chat.hasBlockedMe && !isChannelReadOnly;
  const pinnedMessage = [...messages].reverse().find((m) => m.isPinned && !m.deletedAt) || null;

  const notifyTyping = (active: boolean) => {
    if (chat.type === 'direct' && zimStatus === 'connected') {
      onTyping(peerId, chat.id, active);
    }
    void apiFetch(`/api/v1/chats/${chat.id}/typing`, {
      method: 'POST',
      body: JSON.stringify({ isTyping: active }),
    }).catch(() => {});
  };

  const handleInputChange = (val: string) => {
    setBody(val);
    notifyTyping(Boolean(val.trim()));
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => notifyTyping(false), 2200);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    setComposerError(null);
    setUploading(true);
    try {
      const uploaded: MessageAttachment[] = [];
      for (const file of files.slice(0, 6)) {
        const att = await uploadMediaFile(file);
        uploaded.push(att);
      }
      setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, 6));
    } catch (err) {
      setComposerError(err instanceof ApiError ? err.message : t.uploadError);
    } finally {
      setUploading(false);
    }
  };

  const sendMessagePayload = async (textBody: string, attachmentsToSend: MessageAttachment[]) => {
    if (!canPost) return;
    if (!textBody.trim() && attachmentsToSend.length === 0) return;

    // Handle Edit Mode
    if (editingMsg) {
      try {
        const res = await apiFetch<{ message: ChatMessage }>(`/api/v1/messages/${editingMsg.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body: textBody.trim() }),
        });
        onMessageUpdated(res.message);
        setEditingMsg(null);
        setBody('');
      } catch (err) {
        setComposerError(err instanceof ApiError ? err.message : 'Unable to edit message.');
      }
      return;
    }

    const clientId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: clientId,
      clientId,
      chatId: chat.id,
      senderId: user.id,
      senderName: user.display_name,
      senderUsername: user.username,
      senderAvatar: user.avatar_url,
      senderVerified: user.verified_flag,
      replyToId: replyTo?.id || null,
      replyTo: replyTo
        ? { id: replyTo.id, senderName: replyTo.senderName, body: replyTo.body, deletedAt: replyTo.deletedAt }
        : null,
      body: textBody.trim(),
      isSilent,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      attachments: attachmentsToSend,
      reactions: [],
      status: isOnline ? 'sending' : 'queued',
    };

    onMessageOptimistic(optimistic);
    setBody('');
    setPendingAttachments([]);
    const replyTarget = replyTo?.id;
    setReplyTo(null);
    setIsSilent(false);
    notifyTyping(false);

    if (!isOnline && attachmentsToSend.length === 0) {
      enqueueOfflineMessage({
        clientId,
        chatId: chat.id,
        peerId,
        body: textBody.trim(),
        createdAt: optimistic.createdAt,
      });
      return;
    }

    try {
      const res = await apiFetch<{ message: ChatMessage }>(`/api/v1/chats/${chat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          body: textBody.trim(),
          replyToId: replyTarget,
          isSilent,
          attachments: attachmentsToSend,
        }),
      });
      onMessageConfirmed(clientId, res.message);
      if (chat.type === 'direct' && peerId) {
        void onRealtimeSend(peerId, res.message).catch(() => {});
      }
    } catch (err) {
      if (!navigator.onLine && attachmentsToSend.length === 0) {
        enqueueOfflineMessage({
          clientId,
          chatId: chat.id,
          peerId,
          body: textBody.trim(),
          createdAt: optimistic.createdAt,
        });
      } else {
        setComposerError(err instanceof ApiError ? err.message : 'Send failed');
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessagePayload(body, pendingAttachments);
  };

  const startVoiceRecording = async () => {
    if (!canPost || recording) return;
    setComposerError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recordedChunksRef.current = [];
      recordStartRef.current = Date.now();
      setRecordSeconds(0);

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const durationMs = Math.max(500, Date.now() - recordStartRef.current);
        const chunks = recordedChunksRef.current;
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        setUploading(true);
        try {
          const att = await uploadMediaFile(file, { durationMs, kind: 'voice' });
          await sendMessagePayload('', [att]);
        } catch (err) {
          setComposerError(err instanceof ApiError ? err.message : t.uploadError);
        } finally {
          setUploading(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
    } catch {
      setComposerError(t.micDenied);
    }
  };

  const stopVoiceRecording = (shouldSend: boolean) => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (!shouldSend) {
      recordedChunksRef.current = [];
      rec.ondataavailable = null;
      rec.onstop = () => rec.stream.getTracks().forEach((tr) => tr.stop());
    }
    if (rec.state !== 'inactive') rec.stop();
    setRecording(false);
    setRecordSeconds(0);
  };

  const handleReact = async (msgId: string, emoji: string) => {
    setMenuMsgId(null);
    try {
      const res = await apiFetch<{ message: ChatMessage }>(`/api/v1/messages/${msgId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      if (res.message) onMessageUpdated(res.message);
    } catch {
      // ignore
    }
  };

  const handlePinToggle = async (msgId: string) => {
    setMenuMsgId(null);
    try {
      const res = await apiFetch<{ message: ChatMessage }>(`/api/v1/messages/${msgId}/pin`, {
        method: 'POST',
      });
      if (res.message) onMessageUpdated(res.message);
    } catch {
      // ignore
    }
  };

  const handleDeleteMsg = async (msgId: string) => {
    setMenuMsgId(null);
    try {
      await apiFetch(`/api/v1/messages/${msgId}`, { method: 'DELETE' });
      onMessageDeleted(chat.id, msgId);
    } catch {
      // ignore
    }
  };

  const handleForwardToChat = async (targetChatId: string) => {
    if (!forwardingMsg) return;
    const msgToForward = forwardingMsg;
    setForwardingMsg(null);
    try {
      await apiFetch(`/api/v1/chats/${targetChatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: msgToForward.body,
          forwardedFrom: msgToForward.senderName,
          attachments: msgToForward.attachments,
        }),
      });
    } catch {
      // ignore
    }
  };

  let lastDateLabel = '';

  const subtitleText =
    typingUserIds.length > 0
      ? t.typing
      : chat.type === 'direct'
        ? chat.peer?.online
          ? t.online
          : chat.peer?.lastSeenAt
            ? `${t.lastSeen} ${formatTime(chat.peer.lastSeenAt, locale)}`
            : t.offline
        : chat.type === 'saved'
          ? t.savedInfo
          : `${chat.memberCount} ${chat.type === 'channel' ? t.subscribersCount : t.membersCount}`;

  const avatarKind =
    chat.type === 'saved'
      ? 'saved'
      : chat.type === 'channel'
        ? 'channel'
        : chat.type === 'group'
          ? 'group'
          : 'user';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-[#F5F7FB] dark:bg-[#0B101B]">
      {/* Chat Header */}
      <header className="px-4 py-3 border-b border-slate-200 dark:border-white/10 bg-white/95 dark:bg-[#121A2B]/95 backdrop-blur-xl flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackMobile}
            aria-label="Back"
            className="md:hidden min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={onOpenInfo}
            className="flex items-center gap-3 min-w-0 text-start hover:opacity-90"
          >
            <Avatar
              name={chat.title}
              src={chat.avatarUrl || chat.peer?.avatarUrl}
              kind={avatarKind}
              online={chat.type === 'direct' && Boolean(chat.peer?.online)}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h2 className="font-display text-sm sm:text-base font-bold truncate">{chat.title}</h2>
                {chat.type === 'ai' && <BotBadge size="sm" isVerified={true} />}
                {chat.type === 'direct' && chat.peer?.verified && <VerifiedBadge size="sm" />}
                {chat.type === 'direct' && chat.peer?.developerBadge && <DeveloperBadge size="sm" />}
                {chat.assignedBotName && (
                  <span className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-500 text-[10px] font-bold flex items-center gap-1">
                    <Bot className="w-3 h-3" />
                    <span>Bot: {chat.assignedBotName}</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate flex items-center gap-1.5">
                {typingUserIds.length > 0 ? (
                  <span className="text-indigo-600 dark:text-sky-400 font-medium">{t.typing}</span>
                ) : (
                  <span>{subtitleText}</span>
                )}
              </p>
            </div>
          </button>
        </div>

        {/* Action Buttons: Audio Call, Video/Group Call, Info */}
        <div className="flex items-center gap-1.5 shrink-0">
          {chat.type === 'direct' && !chat.isBlockedByMe && !chat.hasBlockedMe && (
            <>
              <button
                type="button"
                onClick={() => onStartCall('audio')}
                title={t.audioCall}
                aria-label={t.audioCall}
                className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-sky-400 transition-colors"
              >
                <Phone className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => onStartCall('video')}
                title={t.videoCall}
                aria-label={t.videoCall}
                className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-sky-400 transition-colors"
              >
                <Video className="w-5 h-5" />
              </button>
            </>
          )}

          {chat.type === 'group' && (
            <button
              type="button"
              onClick={() => onStartCall('group')}
              title={t.groupCall}
              aria-label={t.groupCall}
              className="min-h-[44px] px-3 rounded-xl flex items-center gap-2 text-xs font-semibold bg-indigo-600/10 text-indigo-600 dark:text-sky-400 hover:bg-indigo-600/20 transition-colors"
            >
              <Video className="w-4 h-4" />
              <span className="hidden sm:inline">{t.groupCall}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenInfo}
            aria-label={t.contactInfo}
            className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <Info className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Pinned Message Bar */}
      {pinnedMessage && (
        <div className="px-4 py-2 border-b border-slate-200 dark:border-white/10 bg-white/80 dark:bg-[#121A2B]/80 flex items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Pin className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-indigo-600 dark:text-sky-400">{t.pinnedBanner}</p>
              <p className="text-slate-600 dark:text-slate-300 truncate">
                {pinnedMessage.body || pinnedMessage.attachments[0]?.originalName || 'Media'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handlePinToggle(pinnedMessage.id)}
            aria-label={t.actionUnpin}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Message Timeline */}
      <div
        className="flex-1 overflow-y-auto slim-scroll px-4 sm:px-6 py-5 space-y-3"
        onClick={() => setMenuMsgId(null)}
      >
        {messages.map((msg) => {
          const dateLabel = formatDateDivider(msg.createdAt, locale);
          const showDate = dateLabel !== lastDateLabel;
          lastDateLabel = dateLabel;
          const isMine = msg.senderId === user.id;

          return (
            <React.Fragment key={msg.id}>
              {showDate && (
                <div className="flex justify-center py-2">
                  <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">{dateLabel}</span>
                </div>
              )}

              <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} group relative`}>
                <div
                  className={`max-w-[84%] sm:max-w-[68%] rounded-2xl px-4 py-2.5 shadow-sm relative ${
                    isMine
                      ? 'bg-indigo-600 text-white rounded-br-md'
                      : 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-white/10 rounded-bl-md'
                  }`}
                >
                  {/* Group/Channel or Bot sender header */}
                  {!isMine && (chat.type === 'group' || chat.type === 'channel' || chat.type === 'ai' || msg.isBot || String(msg.senderId).startsWith('bot_')) && (
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className="text-[11px] font-semibold text-indigo-500 dark:text-sky-400">
                        {msg.senderName}
                      </span>
                      {(msg.isBot || String(msg.senderId).startsWith('bot_') || chat.type === 'ai') ? (
                        <BotBadge size="sm" isVerified={msg.senderVerified} />
                      ) : (
                        <>
                          {msg.senderVerified && <VerifiedBadge size="sm" />}
                          {msg.senderDeveloperBadge && <DeveloperBadge size="sm" />}
                        </>
                      )}
                    </div>
                  )}

                  {/* Forwarded attribution */}
                  {msg.forwardedFrom && !msg.deletedAt && (
                    <p className={`text-[11px] italic mb-1 ${isMine ? 'text-indigo-100' : 'text-slate-400'}`}>
                      {t.forwardedFrom} {msg.forwardedFrom}
                    </p>
                  )}

                  {/* Reply Preview */}
                  {msg.replyTo && !msg.deletedAt && (
                    <div
                      className={`mb-2 px-2.5 py-1.5 rounded-xl text-xs ${
                        isMine ? 'bg-white/15 text-indigo-50' : 'bg-slate-100 dark:bg-[#0B101B] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <p className="font-semibold text-[11px]">{msg.replyTo.senderName}</p>
                      <p className="truncate opacity-85">{msg.replyTo.deletedAt ? t.deletedMessage : msg.replyTo.body || 'Media'}</p>
                    </div>
                  )}

                  {msg.deletedAt ? (
                    <p className="text-xs italic opacity-75">{t.deletedMessage}</p>
                  ) : (
                    <div className="space-y-2">
                      {msg.attachments.map((att, idx) => {
                        if (att.kind === 'image') {
                          return (
                            <button
                              key={`${msg.id}-att-${idx}`}
                              type="button"
                              onClick={() => onOpenLightbox(att)}
                              className="block rounded-xl overflow-hidden focus:outline-none focus:ring-2 focus:ring-sky-400"
                            >
                              <img
                                src={att.url}
                                alt={att.originalName}
                                referrerPolicy="no-referrer"
                                className="max-h-72 w-auto object-cover rounded-xl"
                              />
                            </button>
                          );
                        }
                        if (att.kind === 'video') {
                          return (
                            <video
                              key={`${msg.id}-att-${idx}`}
                              src={att.url}
                              controls
                              className="max-h-72 rounded-xl bg-black"
                            />
                          );
                        }
                        if (att.kind === 'voice') {
                          return <VoiceNotePlayer key={`${msg.id}-att-${idx}`} attachment={att} />;
                        }
                        return (
                          <a
                            key={`${msg.id}-att-${idx}`}
                            href={att.url}
                            download={att.originalName}
                            className={`flex items-center gap-3 p-2.5 rounded-xl transition-colors ${
                              isMine
                                ? 'bg-white/15 hover:bg-white/20 text-white'
                                : 'bg-slate-100 dark:bg-[#0B101B] hover:bg-slate-200/70 dark:hover:bg-white/10'
                            }`}
                          >
                            <FileText className="w-5 h-5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold truncate">{att.originalName}</p>
                              <p className="text-[10px] font-mono-tabular opacity-75">{formatBytes(att.sizeBytes)}</p>
                            </div>
                            <Download className="w-4 h-4 shrink-0" />
                          </a>
                        );
                      })}

                      {msg.body && (
                        <p className="text-[14px] leading-relaxed whitespace-pre-wrap break-words">{msg.body}</p>
                      )}
                    </div>
                  )}

                  {/* Reactions Row */}
                  {msg.reactions && msg.reactions.length > 0 && !msg.deletedAt && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {msg.reactions.map((r) => (
                        <button
                          key={r.emoji}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleReact(msg.id, r.emoji);
                          }}
                          className={`px-2 py-0.5 rounded-full text-xs inline-flex items-center gap-1 transition-colors ${
                            r.reactedByMe
                              ? isMine
                                ? 'bg-white/30 text-white'
                                : 'bg-indigo-600/20 text-indigo-600 dark:text-sky-300'
                              : isMine
                                ? 'bg-white/15 text-indigo-100'
                                : 'bg-slate-100 dark:bg-[#0B101B] text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          <span>{r.emoji}</span>
                          <span className="font-mono-tabular text-[10px]">{r.count}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Footer Meta + Menu Button */}
                  <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] opacity-80">
                    {msg.isPinned && <Pin className="w-3 h-3" />}
                    {msg.isSilent && <BellOff className="w-3 h-3" />}
                    {msg.editedAt && <span>{t.editedTag}</span>}
                    <span className="font-mono-tabular">{formatTime(msg.createdAt, locale)}</span>
                    {isMine && (
                      <span>
                        {msg.status === 'queued' || msg.status === 'sending' ? (
                          <Clock className="w-3 h-3" />
                        ) : msg.status === 'read' ? (
                          <CheckCheck className="w-3.5 h-3.5 text-sky-300" />
                        ) : msg.status === 'delivered' ? (
                          <CheckCheck className="w-3.5 h-3.5" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                      </span>
                    )}
                    {!msg.deletedAt && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuMsgId((cur) => (cur === msg.id ? null : msg.id));
                        }}
                        aria-label="Message options"
                        className="p-0.5 rounded opacity-65 hover:opacity-100"
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Contextual Message Actions Popover */}
                {menuMsgId === msg.id && !msg.deletedAt && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={`absolute z-30 top-full mt-1 ${
                      isMine ? 'end-0' : 'start-0'
                    } w-56 rounded-2xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#121A2B] shadow-2xl p-2 space-y-1`}
                  >
                    <div className="flex items-center justify-between px-1.5 py-1 border-b border-slate-100 dark:border-white/10">
                      {REACTION_CHOICES.map((em) => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => void handleReact(msg.id, em)}
                          className="w-8 h-8 rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 text-base flex items-center justify-center"
                        >
                          {em}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo(msg);
                        setEditingMsg(null);
                        setMenuMsgId(null);
                      }}
                      className="w-full text-start px-3 py-2 rounded-xl text-xs font-medium hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-2.5"
                    >
                      <CornerUpLeft className="w-3.5 h-3.5" />
                      <span>{t.actionReply}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setForwardingMsg(msg);
                        setMenuMsgId(null);
                      }}
                      className="w-full text-start px-3 py-2 rounded-xl text-xs font-medium hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-2.5"
                    >
                      <Forward className="w-3.5 h-3.5" />
                      <span>{t.actionForward}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handlePinToggle(msg.id)}
                      className="w-full text-start px-3 py-2 rounded-xl text-xs font-medium hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-2.5"
                    >
                      <Pin className="w-3.5 h-3.5" />
                      <span>{msg.isPinned ? t.actionUnpin : t.actionPin}</span>
                    </button>

                    {isMine && msg.body && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMsg(msg);
                          setReplyTo(null);
                          setBody(msg.body);
                          setMenuMsgId(null);
                        }}
                        className="w-full text-start px-3 py-2 rounded-xl text-xs font-medium hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-2.5"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>{t.actionEdit}</span>
                      </button>
                    )}

                    {(isMine || chat.myRole === 'owner' || chat.myRole === 'admin') && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteMsg(msg.id)}
                        className="w-full text-start px-3 py-2 rounded-xl text-xs font-medium text-rose-500 hover:bg-rose-500/10 flex items-center gap-2.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{t.actionDelete}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div ref={scrollEndRef} />
      </div>

      {/* Composer */}
      <footer className="px-4 py-3 border-t border-slate-200 dark:border-white/10 bg-white/95 dark:bg-[#121A2B]/95 backdrop-blur-xl space-y-2 shrink-0">
        {composerError && (
          <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 flex items-center justify-between">
            <span>{composerError}</span>
            <button type="button" onClick={() => setComposerError(null)}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Reply / Edit Context Strip */}
        {(replyTo || editingMsg) && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs">
            <div className="flex items-center gap-2 min-w-0">
              {editingMsg ? (
                <Pencil className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
              ) : (
                <CornerUpLeft className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-indigo-600 dark:text-sky-400">
                  {editingMsg ? t.editingMessage : `${t.replyingTo} ${replyTo?.senderName}`}
                </p>
                <p className="text-slate-500 truncate">
                  {editingMsg ? editingMsg.body : replyTo?.body || 'Media'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplyTo(null);
                setEditingMsg(null);
                if (editingMsg) setBody('');
              }}
              className="p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingAttachments.map((att, idx) => (
              <div
                key={att.storageKey || idx}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] border border-slate-200 dark:border-white/10 text-xs"
              >
                <span className="truncate max-w-[160px] font-medium">{att.originalName}</span>
                <button
                  type="button"
                  onClick={() => setPendingAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-slate-400 hover:text-rose-500"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {!canPost ? (
          <p className="text-xs text-center text-slate-500 dark:text-slate-400 py-2">
            {isChannelReadOnly ? t.channelReadOnly : t.blockedNotice}
          </p>
        ) : recording ? (
          <div className="flex items-center justify-between gap-3 px-4 py-2 rounded-2xl bg-rose-500/10 border border-rose-500/30">
            <div className="flex items-center gap-2.5 text-rose-500 text-xs font-semibold">
              <Smile className="w-4 h-4 hidden" />
              <span className="font-mono-tabular">
                {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:
                {String(recordSeconds % 60).padStart(2, '0')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => stopVoiceRecording(false)}
                className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-white/10"
              >
                {t.cancelRecording}
              </button>
              <button
                type="button"
                onClick={() => stopVoiceRecording(true)}
                className="min-h-[40px] px-4 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5" />
                <span>{t.stopRecording}</span>
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,audio/*,.pdf,.txt,.zip,.doc,.docx"
              className="hidden"
              onChange={handleFileSelect}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              title={t.attachFile}
              aria-label={t.attachFile}
              className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 shrink-0"
            >
              <Paperclip className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={() => setIsSilent((s) => !s)}
              title={t.silentSend}
              aria-label={t.silentSend}
              className={`min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                isSilent
                  ? 'bg-indigo-600/15 text-indigo-600 dark:text-sky-400'
                  : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10'
              }`}
            >
              <BellOff className="w-4 h-4" />
            </button>

            <textarea
              rows={1}
              value={body}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessagePayload(body, pendingAttachments);
                }
              }}
              placeholder={uploading ? t.uploadingLabel : t.typeMessage}
              className="flex-1 resize-none max-h-32 px-4 py-3 rounded-2xl bg-slate-100 dark:bg-[#0B101B] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {body.trim() || pendingAttachments.length > 0 ? (
              <button
                type="submit"
                disabled={uploading}
                aria-label={t.send}
                className="min-h-[44px] min-w-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center shrink-0 transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                disabled={uploading}
                onClick={() => void startVoiceRecording()}
                title={t.recordVoice}
                aria-label={t.recordVoice}
                className="min-h-[44px] min-w-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center shrink-0 transition-colors"
              >
                <Mic className="w-4 h-4" />
              </button>
            )}
          </form>
        )}
      </footer>

      {/* Forward Message Modal */}
      {forwardingMsg && (
        <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold">{t.forwardTitle}</h3>
              <button
                type="button"
                onClick={() => setForwardingMsg(null)}
                className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto slim-scroll space-y-1">
              {allChats.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => void handleForwardToChat(target.id)}
                  className="w-full text-start p-2.5 rounded-xl flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-white/5 min-h-[48px]"
                >
                  <Avatar
                    name={target.title}
                    src={target.avatarUrl || target.peer?.avatarUrl}
                    size="sm"
                    kind={
                      target.type === 'saved'
                        ? 'saved'
                        : target.type === 'channel'
                          ? 'channel'
                          : target.type === 'group'
                            ? 'group'
                            : 'user'
                    }
                  />
                  <span className="text-sm font-semibold truncate">{target.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

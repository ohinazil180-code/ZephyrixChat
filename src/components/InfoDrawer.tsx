import React, { useEffect, useState } from 'react';
import {
  Archive,
  Ban,
  BellOff,
  Check,
  CheckCircle2,
  Copy,
  LogOut,
  MapPin,
  Phone,
  Pin,
  Shield,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { formatTime, translations } from '../i18n/translations';
import { apiFetch } from '../lib/api';
import type { ChatMember, ChatMessage, ChatSummary, Locale, MessageAttachment, PeerUser, UserProfile } from '../types/zephyrix';
import { Avatar } from './Avatar';
import { BotBadge, DeveloperBadge, VerifiedBadge } from './Badges';

interface InfoDrawerProps {
  locale: Locale;
  currentUser: UserProfile;
  chat: ChatSummary;
  messages: ChatMessage[];
  onClose: () => void;
  onRefreshChats: () => void;
  onOpenLightbox: (att: MessageAttachment) => void;
}

export const InfoDrawer: React.FC<InfoDrawerProps> = ({
  locale,
  currentUser,
  chat,
  messages,
  onClose,
  onRefreshChats,
  onOpenLightbox,
}) => {
  const t = translations[locale];
  const [tab, setTab] = useState<'overview' | 'members' | 'media'>('overview');
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [copied, setCopied] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addResults, setAddResults] = useState<PeerUser[]>([]);

  useEffect(() => {
    if (chat.type !== 'group' && chat.type !== 'channel') return;
    apiFetch<{ members: ChatMember[] }>(`/api/v1/chats/${chat.id}`)
      .then((res) => setMembers(res.members || []))
      .catch(() => {});
  }, [chat.id, chat.type, chat.memberCount]);

  useEffect(() => {
    if (!addOpen) return;
    const timer = window.setTimeout(() => {
      apiFetch<{ users: PeerUser[] }>(`/api/v1/users/search?q=${encodeURIComponent(addSearch.trim())}`)
        .then((res) => setAddResults(res.users))
        .catch(() => setAddResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [addOpen, addSearch]);

  const handleToggleBlock = async () => {
    if (!chat.peer) return;
    if (chat.isBlockedByMe) {
      await apiFetch(`/api/v1/blocks/${chat.peer.id}`, { method: 'DELETE' });
    } else {
      await apiFetch('/api/v1/blocks', {
        method: 'POST',
        body: JSON.stringify({ userId: chat.peer.id }),
      });
    }
    onRefreshChats();
  };

  const handlePref = async (patch: { pinned?: boolean; muted?: boolean; archived?: boolean }) => {
    await apiFetch(`/api/v1/chats/${chat.id}/preferences`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    onRefreshChats();
  };

  const handleAddMember = async (targetUserId: string) => {
    await apiFetch(`/api/v1/chats/${chat.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: targetUserId }),
    });
    setAddOpen(false);
    onRefreshChats();
    const res = await apiFetch<{ members: ChatMember[] }>(`/api/v1/chats/${chat.id}`).catch(() => null);
    if (res) setMembers(res.members);
  };

  const handleRemoveMember = async (targetUserId: string) => {
    await apiFetch(`/api/v1/chats/${chat.id}/members/${targetUserId}`, { method: 'DELETE' });
    if (targetUserId === currentUser.id) {
      onClose();
      onRefreshChats();
      return;
    }
    setMembers((prev) => prev.filter((m) => m.id !== targetUserId));
    onRefreshChats();
  };

  const handleToggleAdmin = async (member: ChatMember) => {
    const nextRole = member.role === 'admin' ? 'member' : 'admin';
    await apiFetch(`/api/v1/chats/${chat.id}/members/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: nextRole }),
    });
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: nextRole } : m)));
  };

  const sharedMedia = messages.flatMap((m) => (m.deletedAt ? [] : m.attachments));
  const isAdmin = chat.myRole === 'owner' || chat.myRole === 'admin';
  const avatarKind =
    chat.type === 'saved'
      ? 'saved'
      : chat.type === 'channel'
        ? 'channel'
        : chat.type === 'group'
          ? 'group'
          : 'user';

  return (
    <aside className="w-full lg:w-[340px] shrink-0 h-full flex flex-col border-s border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B]">
      <div className="px-4 py-3.5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold truncate">
          {chat.type === 'group'
            ? t.groupInfo
            : chat.type === 'channel'
              ? t.channelInfo
              : chat.type === 'saved'
                ? t.savedInfo
                : t.contactInfo}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-white/10 min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Sub-Tabs */}
      <div className="px-4 pt-3">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B101B]">
          <button
            type="button"
            onClick={() => setTab('overview')}
            className={`flex-1 min-h-[34px] rounded-lg text-xs font-semibold ${
              tab === 'overview' ? 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500'
            }`}
          >
            {t.profileSection}
          </button>
          {(chat.type === 'group' || chat.type === 'channel') && (
            <button
              type="button"
              onClick={() => setTab('members')}
              className={`flex-1 min-h-[34px] rounded-lg text-xs font-semibold ${
                tab === 'members' ? 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500'
              }`}
            >
              {t.membersTab}
            </button>
          )}
          <button
            type="button"
            onClick={() => setTab('media')}
            className={`flex-1 min-h-[34px] rounded-lg text-xs font-semibold ${
              tab === 'media' ? 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500'
            }`}
          >
            {t.sharedMedia}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto slim-scroll p-5 space-y-5">
        {tab === 'overview' && (
          <>
            <div className="flex flex-col items-center text-center space-y-3 py-2">
              <Avatar
                name={chat.title}
                src={chat.avatarUrl || chat.peer?.avatarUrl}
                size="xl"
                kind={avatarKind}
                online={chat.type === 'direct' && Boolean(chat.peer?.online)}
              />
              <div className="space-y-1">
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <p className="font-display text-lg font-bold">{chat.title}</p>
                  {(chat.type === 'ai' || chat.peer?.isBot || Boolean(chat.assignedBotId)) && <BotBadge />}
                  {(chat.peer?.verified || chat.isBotVerified) && <VerifiedBadge />}
                  {chat.peer?.developerBadge && <DeveloperBadge />}
                </div>
                {chat.peer?.username && (
                  <p className="text-xs font-mono-tabular text-indigo-500">@{chat.peer.username}</p>
                )}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {chat.type === 'direct'
                    ? chat.peer?.online
                      ? t.online
                      : chat.peer?.lastSeenAt
                        ? `${t.lastSeen} ${formatTime(chat.peer.lastSeenAt, locale)}`
                        : t.offline
                    : `${chat.memberCount} ${chat.type === 'channel' ? t.subscribersCount : t.membersCount}`}
                </p>
                {(chat.description || chat.peer?.bio) && (
                  <p className="text-xs text-slate-600 dark:text-slate-300 pt-2 leading-relaxed max-w-xs">
                    {chat.description || chat.peer?.bio}
                  </p>
                )}
              </div>
            </div>

            {/* Extra Peer Details */}
            {chat.peer && (chat.peer.phone || chat.peer.country) && (
              <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-white/10 text-xs text-slate-600 dark:text-slate-300">
                {chat.peer.phone && (
                  <div className="flex items-center gap-2.5">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    <span className="font-mono-tabular">{chat.peer.phone}</span>
                  </div>
                )}
                {chat.peer.country && (
                  <div className="flex items-center gap-2.5">
                    <MapPin className="w-3.5 h-3.5 text-slate-400" />
                    <span>{chat.peer.country}</span>
                  </div>
                )}
              </div>
            )}

            {/* Invite Code for Groups & Channels */}
            {chat.inviteCode && (
              <div className="p-3.5 rounded-2xl bg-slate-100 dark:bg-[#0B101B] space-y-1.5">
                <p className="text-[11px] font-semibold text-slate-500">{t.inviteCodeLabel}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-tabular text-sm font-semibold">{chat.inviteCode}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(chat.inviteCode || '');
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1800);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1A2438] text-xs font-semibold inline-flex items-center gap-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? t.copied : t.copyCode}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Chat Preferences */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => void handlePref({ pinned: !chat.pinnedAt })}
                className="min-h-[44px] px-2 rounded-xl border border-slate-200 dark:border-white/10 text-xs font-semibold flex flex-col items-center justify-center gap-1 hover:bg-slate-50 dark:hover:bg-white/5"
              >
                <Pin className="w-3.5 h-3.5 text-indigo-500" />
                <span className="truncate">{chat.pinnedAt ? t.unpinChat : t.pinChat}</span>
              </button>
              <button
                type="button"
                onClick={() => void handlePref({ muted: !chat.mutedUntil })}
                className="min-h-[44px] px-2 rounded-xl border border-slate-200 dark:border-white/10 text-xs font-semibold flex flex-col items-center justify-center gap-1 hover:bg-slate-50 dark:hover:bg-white/5"
              >
                <BellOff className="w-3.5 h-3.5 text-amber-500" />
                <span className="truncate">{chat.mutedUntil ? t.unmuteChat : t.muteChat}</span>
              </button>
              <button
                type="button"
                onClick={() => void handlePref({ archived: !chat.archivedAt })}
                className="min-h-[44px] px-2 rounded-xl border border-slate-200 dark:border-white/10 text-xs font-semibold flex flex-col items-center justify-center gap-1 hover:bg-slate-50 dark:hover:bg-white/5"
              >
                <Archive className="w-3.5 h-3.5 text-sky-500" />
                <span className="truncate">{chat.archivedAt ? t.unarchiveChat : t.archiveChat}</span>
              </button>
            </div>

            {chat.peer && (
              <button
                type="button"
                onClick={() => void handleToggleBlock()}
                className={`w-full flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold border transition-colors min-h-[44px] ${
                  chat.isBlockedByMe
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
                }`}
              >
                <Ban className="w-4 h-4" />
                <span>{chat.isBlockedByMe ? t.unblock : t.blockUser}</span>
              </button>
            )}

            {(chat.type === 'group' || chat.type === 'channel') && (
              <button
                type="button"
                onClick={() => void handleRemoveMember(currentUser.id)}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300 min-h-[44px]"
              >
                <LogOut className="w-4 h-4" />
                <span>{t.leaveGroup}</span>
              </button>
            )}
          </>
        )}

        {tab === 'members' && (
          <div className="space-y-3">
            {isAdmin && (
              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                className="w-full min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-2"
              >
                <UserPlus className="w-4 h-4" />
                <span>{t.inviteMembersLabel}</span>
              </button>
            )}

            {addOpen && (
              <div className="p-3 rounded-2xl bg-slate-100 dark:bg-[#0B101B] space-y-2">
                <input
                  type="text"
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  placeholder={t.searchPlaceholder}
                  className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#121A2B] text-xs focus:outline-none"
                />
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {addResults
                    .filter((u) => !members.some((m) => m.id === u.id))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => void handleAddMember(u.id)}
                        className="w-full text-start p-2 rounded-xl flex items-center gap-2 hover:bg-white dark:hover:bg-white/5"
                      >
                        <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <p className="text-xs font-semibold truncate">{u.displayName}</p>
                            {u.isBot && <BotBadge />}
                            {u.verified && <VerifiedBadge />}
                            {u.developerBadge && <DeveloperBadge />}
                          </div>
                          <p className="text-[11px] text-slate-500 truncate">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              {members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-2xl border border-slate-200 dark:border-white/10"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={m.displayName} src={m.avatarUrl} size="sm" online={m.online} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 min-w-0">
                        <p className="text-xs font-semibold truncate">{m.displayName}</p>
                        {m.isBot && <BotBadge />}
                        {m.verified && <VerifiedBadge />}
                        {m.developerBadge && <DeveloperBadge />}
                      </div>
                      <p className="text-[11px] text-slate-500 truncate">
                        @{m.username} · {m.role}
                      </p>
                    </div>
                  </div>

                  {chat.myRole === 'owner' && m.id !== currentUser.id && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleToggleAdmin(m)}
                        title="Toggle admin"
                        className="p-2 rounded-lg text-indigo-500 hover:bg-indigo-500/10"
                      >
                        <Shield className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveMember(m.id)}
                        title="Remove member"
                        className="p-2 rounded-lg text-rose-500 hover:bg-rose-500/10"
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'media' && (
          <div className="grid grid-cols-3 gap-2">
            {sharedMedia.filter((a) => a.kind === 'image').length === 0 ? (
              <p className="col-span-3 text-xs text-center text-slate-500 py-8">{t.noMessagesYet}</p>
            ) : (
              sharedMedia
                .filter((a) => a.kind === 'image')
                .map((att, i) => (
                  <button
                    key={`${att.storageKey}-${i}`}
                    type="button"
                    onClick={() => onOpenLightbox(att)}
                    className="aspect-square rounded-xl overflow-hidden border border-slate-200 dark:border-white/10"
                  >
                    <img
                      src={att.url}
                      alt={att.originalName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

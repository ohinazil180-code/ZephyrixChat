import React, { useEffect, useState } from 'react';
import {
  Archive,
  BellOff,
  Bookmark,
  Check,
  Hash,
  KeyRound,
  MessageSquarePlus,
  Moon,
  Pin,
  Search,
  Settings,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { formatNumber, formatTime, translations } from '../i18n/translations';
import { ApiError, apiFetch } from '../lib/api';
import type { ChatSummary, ChatType, Locale, PeerUser, ThemeMode, UserProfile } from '../types/zephyrix';
import { Avatar } from './Avatar';
import { PWAInstallButton } from './PWAInstallButton';

interface SidebarProps {
  locale: Locale;
  onLocaleChange: (l: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  user: UserProfile;
  chats: ChatSummary[];
  activeChatId: string | null;
  typingByChat: Record<string, string[]>;
  onSelectChat: (chatId: string) => void;
  onUpdateChatPref: (
    chat: ChatSummary,
    patch: { pinned?: boolean; muted?: boolean; archived?: boolean }
  ) => void;
  onOpenSettings: () => void;
  onChatsChanged: (selectChatId?: string) => void;
}

type FilterTab = 'all' | ChatType;

export const Sidebar: React.FC<SidebarProps> = ({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  user,
  chats,
  activeChatId,
  typingByChat,
  onSelectChat,
  onUpdateChatPref,
  onOpenSettings,
  onChatsChanged,
}) => {
  const t = translations[locale];
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [userResults, setUserResults] = useState<PeerUser[]>([]);
  const [contextMenu, setContextMenu] = useState<{ chat: ChatSummary; x: number; y: number } | null>(null);

  // Creation / Join modal
  const [modalMode, setModalMode] = useState<null | 'direct' | 'group' | 'channel' | 'join'>(null);
  const [modalSearch, setModalSearch] = useState('');
  const [modalUsers, setModalUsers] = useState<PeerUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [roomTitle, setRoomTitle] = useState('');
  const [roomDescription, setRoomDescription] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setUserResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ users: PeerUser[] }>(
          `/api/v1/users/search?q=${encodeURIComponent(q)}`
        );
        setUserResults(res.users);
      } catch {
        setUserResults([]);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!modalMode || modalMode === 'join') return;
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ users: PeerUser[] }>(
          `/api/v1/users/search?q=${encodeURIComponent(modalSearch.trim())}`
        );
        setModalUsers(res.users);
      } catch {
        setModalUsers([]);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [modalMode, modalSearch]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const openModal = (mode: 'direct' | 'group' | 'channel' | 'join') => {
    setModalError(null);
    setModalSearch('');
    setSelectedMemberIds([]);
    setRoomTitle('');
    setRoomDescription('');
    setInviteCode('');
    setModalMode(mode);
  };

  const startDirectChat = async (targetUserId: string) => {
    setModalError(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ chat: ChatSummary }>('/api/v1/chats', {
        method: 'POST',
        body: JSON.stringify({ type: 'direct', targetUserId }),
      });
      setModalMode(null);
      setSearchQuery('');
      onChatsChanged(res.chat.id);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Unable to start chat.');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateGroupOrChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalMode || (modalMode !== 'group' && modalMode !== 'channel')) return;
    setModalError(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ chat: ChatSummary }>('/api/v1/chats', {
        method: 'POST',
        body: JSON.stringify({
          type: modalMode,
          title: roomTitle.trim(),
          description: roomDescription.trim(),
          memberIds: selectedMemberIds,
        }),
      });
      setModalMode(null);
      onChatsChanged(res.chat.id);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Unable to create conversation.');
    } finally {
      setCreating(false);
    }
  };

  const handleJoinViaCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ chat: ChatSummary }>('/api/v1/chats/join', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: inviteCode.trim() }),
      });
      setModalMode(null);
      onChatsChanged(res.chat.id);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Invalid invite code.');
    } finally {
      setCreating(false);
    }
  };

  const toggleMemberSelection = (id: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const filteredChats = chats.filter((c) => {
    const isArchived = Boolean(c.archivedAt);
    if (showArchived !== isArchived) return false;
    if (filterTab !== 'all' && c.type !== filterTab) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      Boolean(c.peer?.username.toLowerCase().includes(q)) ||
      Boolean(c.lastMessage?.body.toLowerCase().includes(q))
    );
  });

  const pinnedChats = filteredChats.filter((c) => Boolean(c.pinnedAt));
  const regularChats = filteredChats.filter((c) => !c.pinnedAt);

  const archivedCount = chats.filter((c) => Boolean(c.archivedAt)).length;
  const isSearchingMode = Boolean(searchQuery.trim());

  const tabs: Array<{ id: FilterTab; label: string }> = [
    { id: 'all', label: t.filterAll },
    { id: 'direct', label: t.filterDirect },
    { id: 'group', label: t.filterGroups },
    { id: 'channel', label: t.filterChannels },
    { id: 'saved', label: t.filterSaved },
  ];

  return (
    <div className="w-full md:w-[360px] lg:w-[390px] shrink-0 h-full flex border-e border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B]">
      {/* Desktop Left Utility Rail */}
      <aside className="hidden md:flex flex-col items-center justify-between w-[68px] shrink-0 py-4 border-e border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#0B101B]/60">
        <div className="flex flex-col items-center gap-2.5">
          <img src="/icon.svg" alt="Zephyrix" className="w-10 h-10 rounded-2xl shadow-sm mb-1" />
          <button
            type="button"
            onClick={() => openModal('direct')}
            title={t.newChat}
            aria-label={t.newChat}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-sky-400 hover:bg-indigo-500/10 transition-colors"
          >
            <MessageSquarePlus className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => openModal('group')}
            title={t.newGroup}
            aria-label={t.newGroup}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
          >
            <Users className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => openModal('channel')}
            title={t.newChannel}
            aria-label={t.newChannel}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
          >
            <Hash className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => openModal('join')}
            title={t.joinInvite}
            aria-label={t.joinInvite}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
          >
            <KeyRound className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => onLocaleChange(locale === 'en' ? 'bn' : 'en')}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-xs font-bold text-indigo-600 dark:text-sky-400 hover:bg-indigo-500/10"
          >
            {locale === 'en' ? 'বাং' : 'EN'}
          </button>
          <button
            type="button"
            onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-indigo-600" />}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t.settings}
            className="rounded-2xl p-0.5 hover:ring-2 hover:ring-indigo-500 transition-all min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <Avatar name={user.display_name} src={user.avatar_url} size="sm" />
          </button>
        </div>
      </aside>

      {/* Main Conversation Column */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Compact Header & Search */}
        <div className="px-4 pt-3.5 pb-3 space-y-3 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <img src="/icon.svg" alt="Zephyrix" className="w-7 h-7 rounded-lg md:hidden" />
              <h1 className="font-display text-lg font-bold tracking-tight truncate">{t.brand}</h1>
            </div>

            <div className="flex items-center gap-1.5">
              <PWAInstallButton locale={locale} />
              {archivedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className={`min-h-[36px] px-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border transition-colors ${
                    showArchived
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
                  }`}
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>{showArchived ? t.hideArchived : formatNumber(archivedCount, locale)}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label={t.settings}
                className="md:hidden min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <Settings className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="w-full ps-9 pe-8 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-transparent focus:border-indigo-500/50 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Interactive Filter Tabs */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B101B] overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterTab(tab.id)}
                className={`flex-1 min-h-[34px] px-2.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                  filterTab === tab.id
                    ? 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-y-auto slim-scroll p-2 space-y-1">
          {pinnedChats.length > 0 && (
            <div className="px-3 pt-1 pb-1.5 flex items-center justify-between text-[11px] font-semibold text-indigo-600 dark:text-sky-400">
              <span className="inline-flex items-center gap-1.5">
                <Pin className="w-3 h-3 -rotate-45" />
                <span>{t.pinnedSectionLabel}</span>
              </span>
              <span className="font-mono-tabular text-slate-400">{formatNumber(pinnedChats.length, locale)}</span>
            </div>
          )}

          {pinnedChats.map((chat) => {
            const isActive = chat.id === activeChatId;
            const typingCount = (typingByChat[chat.id] || []).length;
            const avatarKind =
              chat.type === 'saved'
                ? 'saved'
                : chat.type === 'channel'
                  ? 'channel'
                  : chat.type === 'group'
                    ? 'group'
                    : 'user';

            return (
              <div
                key={chat.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({
                    chat,
                    x: Math.min(e.clientX, window.innerWidth - 200),
                    y: Math.min(e.clientY, window.innerHeight - 170),
                  });
                }}
                className={`group flex items-center rounded-2xl border transition-colors ${
                  isActive
                    ? 'bg-indigo-600/12 dark:bg-indigo-500/18 border-indigo-500/30'
                    : 'bg-indigo-500/[0.035] dark:bg-sky-400/[0.04] hover:bg-slate-100 dark:hover:bg-white/5 border-indigo-500/10 dark:border-white/5'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectChat(chat.id)}
                  className="flex-1 min-w-0 text-start ps-3 pe-1 py-2.5 flex items-center gap-3 min-h-[64px]"
                >
                  <Avatar
                    name={chat.title}
                    src={chat.avatarUrl || chat.peer?.avatarUrl}
                    kind={avatarKind}
                    online={chat.type === 'direct' && Boolean(chat.peer?.online)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm truncate flex items-center gap-1.5">
                        <span className="truncate">{chat.title}</span>
                        {chat.mutedUntil && <BellOff className="w-3 h-3 text-slate-400 shrink-0" />}
                      </span>
                      <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                        {chat.lastMessage ? formatTime(chat.lastMessage.createdAt, locale) : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {typingCount > 0 ? (
                          <span className="text-indigo-600 dark:text-sky-400 font-medium">{t.typing}</span>
                        ) : chat.lastMessage ? (
                          chat.lastMessage.deletedAt ? (
                            t.deletedMessage
                          ) : chat.lastMessage.body ? (
                            chat.lastMessage.body
                          ) : (
                            chat.lastMessage.attachments[0]?.originalName || 'Attachment'
                          )
                        ) : chat.type === 'saved' ? (
                          t.savedInfo
                        ) : (
                          t.noMessagesYet
                        )}
                      </p>
                      {chat.unreadCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-mono-tabular font-semibold shrink-0">
                          {formatNumber(chat.unreadCount, locale)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onUpdateChatPref(chat, { pinned: false })}
                  title={t.unpinChat}
                  aria-label={`${t.unpinChat}: ${chat.title}`}
                  className="me-1.5 min-w-[36px] min-h-[36px] rounded-xl flex items-center justify-center text-indigo-600 dark:text-sky-400 hover:bg-indigo-500/15 transition-colors shrink-0"
                >
                  <Pin className="w-3.5 h-3.5 -rotate-45 fill-current" />
                </button>
              </div>
            );
          })}

          {pinnedChats.length > 0 && regularChats.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold text-slate-400 border-t border-slate-200/70 dark:border-white/10 mt-1.5">
              {t.recentChatsLabel}
            </div>
          )}

          {regularChats.map((chat) => {
            const isActive = chat.id === activeChatId;
            const typingCount = (typingByChat[chat.id] || []).length;
            const avatarKind =
              chat.type === 'saved'
                ? 'saved'
                : chat.type === 'channel'
                  ? 'channel'
                  : chat.type === 'group'
                    ? 'group'
                    : 'user';

            return (
              <div
                key={chat.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({
                    chat,
                    x: Math.min(e.clientX, window.innerWidth - 200),
                    y: Math.min(e.clientY, window.innerHeight - 170),
                  });
                }}
                className={`group flex items-center rounded-2xl border transition-colors ${
                  isActive
                    ? 'bg-indigo-600/10 dark:bg-indigo-500/15 border-indigo-500/25'
                    : 'hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectChat(chat.id)}
                  className="flex-1 min-w-0 text-start ps-3 pe-1 py-2.5 flex items-center gap-3 min-h-[64px]"
                >
                  <Avatar
                    name={chat.title}
                    src={chat.avatarUrl || chat.peer?.avatarUrl}
                    kind={avatarKind}
                    online={chat.type === 'direct' && Boolean(chat.peer?.online)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm truncate flex items-center gap-1.5">
                        <span className="truncate">{chat.title}</span>
                        {chat.mutedUntil && <BellOff className="w-3 h-3 text-slate-400 shrink-0" />}
                      </span>
                      <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                        {chat.lastMessage ? formatTime(chat.lastMessage.createdAt, locale) : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {typingCount > 0 ? (
                          <span className="text-indigo-600 dark:text-sky-400 font-medium">{t.typing}</span>
                        ) : chat.lastMessage ? (
                          chat.lastMessage.deletedAt ? (
                            t.deletedMessage
                          ) : chat.lastMessage.body ? (
                            chat.lastMessage.body
                          ) : (
                            chat.lastMessage.attachments[0]?.originalName || 'Attachment'
                          )
                        ) : chat.type === 'saved' ? (
                          t.savedInfo
                        ) : (
                          t.noMessagesYet
                        )}
                      </p>
                      {chat.unreadCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-mono-tabular font-semibold shrink-0">
                          {formatNumber(chat.unreadCount, locale)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onUpdateChatPref(chat, { pinned: true })}
                  title={t.pinChat}
                  aria-label={`${t.pinChat}: ${chat.title}`}
                  className="me-1.5 min-w-[36px] min-h-[36px] rounded-xl flex items-center justify-center text-slate-400 opacity-50 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-indigo-600 dark:hover:text-sky-400 hover:bg-indigo-500/10 transition-opacity shrink-0"
                >
                  <Pin className="w-3.5 h-3.5 -rotate-45" />
                </button>
              </div>
            );
          })}

          {/* Global User Search Results */}
          {isSearchingMode && userResults.length > 0 && (
            <div className="pt-3 mt-2 border-t border-slate-200 dark:border-white/10 space-y-1">
              <p className="px-3 text-[11px] font-semibold text-slate-400">{t.newChat}</p>
              {userResults.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => void startDirectChat(u.id)}
                  className="w-full text-start p-2.5 rounded-2xl flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-white/5 min-h-[56px]"
                >
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" online={u.online} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{u.displayName}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">@{u.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {filteredChats.length === 0 && (!isSearchingMode || userResults.length === 0) && (
            <div className="py-12 px-4 text-center space-y-3">
              <p className="text-sm text-slate-500 dark:text-slate-400">{t.emptySearch}</p>
              <button
                type="button"
                onClick={() => openModal('direct')}
                className="min-h-[44px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold inline-flex items-center gap-2"
              >
                <MessageSquarePlus className="w-4 h-4" />
                <span>{t.newChat}</span>
              </button>
            </div>
          )}
        </div>

        {/* Mobile Bottom Thumb-Zone Nav */}
        <nav className="md:hidden grid grid-cols-4 items-center border-t border-slate-200 dark:border-white/10 bg-white/95 dark:bg-[#0B101B]/95 backdrop-blur-md h-16 shrink-0">
          <button
            type="button"
            onClick={() => openModal('direct')}
            className="flex flex-col items-center justify-center gap-1 min-h-[44px] text-indigo-600 dark:text-sky-400"
          >
            <MessageSquarePlus className="w-5 h-5" />
            <span className="text-[10px] font-medium">{t.newChat}</span>
          </button>
          <button
            type="button"
            onClick={() => openModal('group')}
            className="flex flex-col items-center justify-center gap-1 min-h-[44px] text-slate-600 dark:text-slate-300"
          >
            <Users className="w-5 h-5" />
            <span className="text-[10px] font-medium">{t.filterGroups}</span>
          </button>
          <button
            type="button"
            onClick={() => openModal('channel')}
            className="flex flex-col items-center justify-center gap-1 min-h-[44px] text-slate-600 dark:text-slate-300"
          >
            <Hash className="w-5 h-5" />
            <span className="text-[10px] font-medium">{t.filterChannels}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const saved = chats.find((c) => c.type === 'saved');
              if (saved) onSelectChat(saved.id);
              else openModal('join');
            }}
            className="flex flex-col items-center justify-center gap-1 min-h-[44px] text-slate-600 dark:text-slate-300"
          >
            <Bookmark className="w-5 h-5" />
            <span className="text-[10px] font-medium">{t.filterSaved}</span>
          </button>
        </nav>
      </div>

      {/* Create Chat / Group / Channel / Join Modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {modalMode === 'direct'
                  ? t.newChat
                  : modalMode === 'group'
                    ? t.newGroup
                    : modalMode === 'channel'
                      ? t.newChannel
                      : t.joinInvite}
              </h3>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                aria-label={t.close}
                className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalError && (
              <p className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2">
                {modalError}
              </p>
            )}

            {modalMode === 'join' ? (
              <form onSubmit={handleJoinViaCode} className="space-y-4">
                <input
                  type="text"
                  required
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder={t.joinCodePlaceholder}
                  className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm font-mono-tabular border border-slate-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  disabled={creating}
                  className="w-full min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold"
                >
                  {t.joinBtn}
                </button>
              </form>
            ) : modalMode === 'direct' ? (
              <div className="space-y-3">
                <input
                  type="text"
                  value={modalSearch}
                  onChange={(e) => setModalSearch(e.target.value)}
                  placeholder={t.searchPlaceholder}
                  autoFocus
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="max-h-72 overflow-y-auto slim-scroll space-y-1">
                  {modalUsers.length === 0 ? (
                    <p className="text-xs text-center text-slate-500 py-6">{t.emptySearch}</p>
                  ) : (
                    modalUsers.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        disabled={creating}
                        onClick={() => void startDirectChat(u.id)}
                        className="w-full text-start p-2.5 rounded-xl flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-white/5 min-h-[52px]"
                      >
                        <Avatar name={u.displayName} src={u.avatarUrl} size="sm" online={u.online} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{u.displayName}</p>
                          <p className="text-xs text-slate-500 truncate">@{u.username}</p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateGroupOrChannel} className="space-y-3.5">
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {modalMode === 'group' ? t.groupNameLabel : t.channelNameLabel}
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={80}
                    value={roomTitle}
                    onChange={(e) => setRoomTitle(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t.descriptionLabel}</span>
                  <input
                    type="text"
                    maxLength={240}
                    value={roomDescription}
                    onChange={(e) => setRoomDescription(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>

                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {t.inviteMembersLabel} ({selectedMemberIds.length})
                  </span>
                  <input
                    type="text"
                    value={modalSearch}
                    onChange={(e) => setModalSearch(e.target.value)}
                    placeholder={t.searchPlaceholder}
                    className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs focus:outline-none"
                  />
                  <div className="max-h-40 overflow-y-auto slim-scroll space-y-1">
                    {modalUsers.map((u) => {
                      const picked = selectedMemberIds.includes(u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => toggleMemberSelection(u.id)}
                          className={`w-full text-start p-2 rounded-xl flex items-center gap-2.5 min-h-[44px] ${
                            picked ? 'bg-indigo-600/15' : 'hover:bg-slate-100 dark:hover:bg-white/5'
                          }`}
                        >
                          <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold truncate">{u.displayName}</p>
                            <p className="text-[11px] text-slate-500 truncate">@{u.username}</p>
                          </div>
                          {picked && <Check className="w-4 h-4 text-indigo-500 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={creating}
                  className="w-full min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-60"
                >
                  {t.createBtn}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Right-Click Chat Context Menu (Pin / Mute / Archive) */}
      {contextMenu && (
        <div
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-48 rounded-2xl border border-slate-200 dark:border-white/15 bg-white/95 dark:bg-[#141C2E]/95 backdrop-blur-xl shadow-2xl p-1.5 space-y-0.5"
        >
          <button
            type="button"
            onClick={() => {
              onUpdateChatPref(contextMenu.chat, { pinned: !contextMenu.chat.pinnedAt });
              setContextMenu(null);
            }}
            className="w-full min-h-[38px] px-3 rounded-xl text-xs font-semibold flex items-center gap-2.5 text-slate-800 dark:text-slate-100 hover:bg-indigo-500/10"
          >
            <Pin className="w-3.5 h-3.5 text-indigo-500 -rotate-45" />
            <span>{contextMenu.chat.pinnedAt ? t.unpinChat : t.pinChat}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateChatPref(contextMenu.chat, { muted: !contextMenu.chat.mutedUntil });
              setContextMenu(null);
            }}
            className="w-full min-h-[38px] px-3 rounded-xl text-xs font-semibold flex items-center gap-2.5 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <BellOff className="w-3.5 h-3.5 text-slate-400" />
            <span>{contextMenu.chat.mutedUntil ? t.unmuteChat : t.muteChat}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateChatPref(contextMenu.chat, { archived: !contextMenu.chat.archivedAt });
              setContextMenu(null);
            }}
            className="w-full min-h-[38px] px-3 rounded-xl text-xs font-semibold flex items-center gap-2.5 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <Archive className="w-3.5 h-3.5 text-slate-400" />
            <span>{contextMenu.chat.archivedAt ? t.unarchiveChat : t.archiveChat}</span>
          </button>
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Clock,
  Edit2,
  FileText,
  Plus,
  Shield,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { translations } from '../i18n/translations';
import { ApiError, apiFetch } from '../lib/api';
import type { BotConfig, Locale, UserProfile } from '../types/zephyrix';
import { Avatar } from './Avatar';
import { AdminBadge, BotBadge, DeveloperBadge, VerifiedBadge } from './Badges';

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  currentUser: UserProfile;
}

interface AdminUser {
  id: string;
  email: string;
  username: string;
  display_name: string;
  phone: string;
  country: string;
  is_admin: number;
  is_banned: number;
  ban_reason: string;
  verified_flag: number;
  developer_badge: number;
  created_at: string;
}

interface AdminChat {
  id: string;
  type: string;
  title: string;
  description: string;
  is_banned: number;
  ban_reason: string;
  owner_name: string;
  assigned_bot_id?: string | null;
}

interface AuditLogEntry {
  id: string;
  admin_name: string;
  admin_username: string;
  action: string;
  target_id: string;
  details: string;
  created_at: string;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  open,
  onClose,
  locale,
  currentUser,
}) => {
  const t = translations[locale];
  const [activeTab, setActiveTab] = useState<'users' | 'bots' | 'chats' | 'audit'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [chats, setChats] = useState<AdminChat[]>([]);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // New Bot Registration / Prompt Editor Modal state
  const [showBotModal, setShowBotModal] = useState(false);
  const [editingBot, setEditingBot] = useState<BotConfig | null>(null);
  const [botName, setBotName] = useState('');
  const [botHandle, setBotHandle] = useState('');
  const [botDescription, setBotDescription] = useState('');
  const [botProvider, setBotProvider] = useState<'gemini' | 'custom' | 'openai'>('gemini');
  const [botModel, setBotModel] = useState('gemini-4-hydrogen');
  const [botEndpoint, setBotEndpoint] = useState('');
  const [botApiKey, setBotApiKey] = useState('');
  const [botSystemInstruction, setBotSystemInstruction] = useState('You are Zephyrix AI, an elite intelligent assistant supporting multimodal text, voice, and file analysis.');
  const [botIsVerified, setBotIsVerified] = useState(true);
  const [botAssignedChatId, setBotAssignedChatId] = useState('');
  const [savingBot, setSavingBot] = useState(false);

  // Prompt simulation sandbox inside prompt editor
  const [testPrompt, setTestPrompt] = useState('Hello Zephyrix AI, analyze this secure channel.');
  const [testResponse, setTestResponse] = useState<string | null>(null);
  const [testingPrompt, setTestingPrompt] = useState(false);

  // Confirmation modal state
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    actionLabel: string;
    isDestructive?: boolean;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const fetchAdminData = async () => {
    if (!open || !currentUser.is_admin) return;
    setLoading(true);
    setError(null);
    try {
      const [usersRes, chatsRes, botsRes, auditRes] = await Promise.all([
        apiFetch<{ users: AdminUser[] }>('/api/v1/admin/users'),
        apiFetch<{ chats: AdminChat[] }>('/api/v1/admin/chats'),
        apiFetch<{ bots: BotConfig[] }>('/api/v1/admin/bots').catch(() => ({ bots: [] })),
        apiFetch<{ logs: AuditLogEntry[] }>('/api/v1/admin/audit-logs').catch(() => ({ logs: [] })),
      ]);
      setUsers(usersRes.users);
      setChats(chatsRes.chats);
      setBots(botsRes.bots);
      setAuditLogs(auditRes.logs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAdminData();
  }, [open, currentUser.is_admin]);

  if (!open || !currentUser.is_admin) return null;

  const handleToggleAdmin = async (userId: string, currentAdmin: number) => {
    const nextAdmin = currentAdmin === 0;
    setConfirmModal({
      title: nextAdmin ? 'Grant Super Admin Privileges' : 'Revoke Admin Privileges',
      message: `Are you sure you want to ${nextAdmin ? 'grant Super Admin privileges to' : 'revoke admin privileges from'} this user?`,
      actionLabel: nextAdmin ? 'Grant Admin' : 'Revoke',
      onConfirm: async () => {
        await apiFetch(`/api/v1/admin/users/${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ isAdmin: nextAdmin }),
        });
        setFeedback('User role updated and logged in Audit Logs.');
        await fetchAdminData();
      },
    });
  };

  const handleBanSuspendUser = async (userId: string, currentBanned: number) => {
    const nextBanned = currentBanned === 0;
    const defaultReason = nextBanned ? 'Violation of Zephyrix community guidelines & terms.' : '';
    const reason = nextBanned ? window.prompt('Enter ban / suspension reason for user:', defaultReason) : '';
    if (nextBanned && reason === null) return;

    setConfirmModal({
      title: nextBanned ? 'Suspend / Ban User' : 'Unban User',
      message: nextBanned
        ? `Are you sure you want to suspend this user? Reason: "${reason}"`
        : 'Are you sure you want to lift the ban on this user?',
      actionLabel: nextBanned ? 'Suspend User' : 'Unban',
      isDestructive: nextBanned,
      onConfirm: async () => {
        await apiFetch(`/api/v1/admin/users/${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ isBanned: nextBanned, banReason: reason || '' }),
        });
        setFeedback(nextBanned ? 'User suspended with automated notice sent.' : 'User ban lifted.');
        await fetchAdminData();
      },
    });
  };

  const handleToggleBadge = async (userId: string, badgeType: 'verified' | 'developer', currentVal: number) => {
    const nextVal = currentVal === 0;
    try {
      await apiFetch(`/api/v1/admin/users/${userId}/badges`, {
        method: 'PATCH',
        body: JSON.stringify({ [badgeType]: nextVal }),
      });
      setFeedback(`User ${badgeType} badge updated`);
      await fetchAdminData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update badge');
    }
  };

  const handleToggleChatBan = async (chatId: string, currentBanned: number) => {
    const nextBanned = currentBanned === 0;
    const reason = nextBanned ? window.prompt('Enter group/channel ban reason:', 'Copyright or safety violation') : '';
    if (nextBanned && reason === null) return;

    setConfirmModal({
      title: nextBanned ? 'Ban Group or Channel' : 'Unban Group/Channel',
      message: nextBanned
        ? `Are you sure you want to ban this conversation? All members will receive an automated suspension notice.`
        : 'Lift ban on this conversation?',
      actionLabel: nextBanned ? 'Ban Conversation' : 'Unban',
      isDestructive: nextBanned,
      onConfirm: async () => {
        await apiFetch(`/api/v1/admin/chats/${chatId}/ban`, {
          method: 'PATCH',
          body: JSON.stringify({ isBanned: nextBanned, banReason: reason || '' }),
        });
        setFeedback('Conversation moderation updated.');
        await fetchAdminData();
      },
    });
  };

  // Bot Manager & Prompt Editor Handlers
  const handleOpenCreateBot = () => {
    setEditingBot(null);
    setBotName('');
    setBotHandle('');
    setBotDescription('');
    setBotProvider('gemini');
    setBotModel('gemini-4-hydrogen');
    setBotEndpoint('');
    setBotApiKey('');
    setBotSystemInstruction('You are Zephyrix AI, an elite intelligent assistant supporting multimodal text, voice, and file analysis.');
    setBotIsVerified(true);
    setBotAssignedChatId('');
    setTestResponse(null);
    setShowBotModal(true);
  };

  const handleOpenEditBot = (b: BotConfig) => {
    setEditingBot(b);
    setBotName(b.name);
    setBotHandle(b.handle);
    setBotDescription(b.description || '');
    setBotProvider(b.provider || 'gemini');
    setBotModel(b.model || 'gemini-4-hydrogen');
    setBotEndpoint(b.api_endpoint || '');
    setBotApiKey('');
    setBotSystemInstruction(b.system_instruction || 'You are Zephyrix AI, an elite intelligent assistant supporting multimodal text, voice, and file analysis.');
    setBotIsVerified(Boolean(b.is_verified));
    setBotAssignedChatId(b.assigned_chat_id || '');
    setTestResponse(null);
    setShowBotModal(true);
  };

  const handleSaveBot = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBot(true);
    setError(null);
    try {
      if (editingBot) {
        await apiFetch(`/api/v1/admin/bots/${editingBot.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: botName.trim(),
            handle: botHandle.trim(),
            description: botDescription.trim(),
            provider: botProvider,
            model: botModel.trim(),
            api_endpoint: botEndpoint.trim(),
            api_key: botApiKey.trim() || undefined,
            system_instruction: botSystemInstruction.trim(),
            is_verified: botIsVerified,
            assigned_chat_id: botAssignedChatId || null,
          }),
        });
        setFeedback('Bot settings & system prompt updated successfully');
      } else {
        await apiFetch('/api/v1/admin/bots', {
          method: 'POST',
          body: JSON.stringify({
            name: botName.trim(),
            handle: botHandle.trim(),
            description: botDescription.trim(),
            provider: botProvider,
            model: botModel.trim(),
            api_endpoint: botEndpoint.trim(),
            api_key: botApiKey.trim(),
            system_instruction: botSystemInstruction.trim(),
            is_verified: botIsVerified,
            assigned_chat_id: botAssignedChatId || undefined,
          }),
        });
        setFeedback('New AI Bot registered successfully');
      }
      setShowBotModal(false);
      await fetchAdminData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save bot');
    } finally {
      setSavingBot(false);
    }
  };

  const handleTestPromptSandbox = async () => {
    setTestingPrompt(true);
    setTestResponse(null);
    try {
      const res = await apiFetch<{ reply: string }>('/api/v1/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          prompt: testPrompt,
          systemInstruction: botSystemInstruction,
          model: botModel,
        }),
      });
      setTestResponse(res.reply || 'Simulated response received successfully.');
    } catch (err) {
      setTestResponse(`Simulation error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTestingPrompt(false);
    }
  };

  const handleToggleBotVerified = async (botId: string, currentVerified: boolean) => {
    try {
      await apiFetch(`/api/v1/admin/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_verified: !currentVerified }),
      });
      setFeedback('Bot verified badge toggled');
      await fetchAdminData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update bot');
    }
  };

  const handleReassignBot = async (botId: string, targetChatId: string) => {
    try {
      await apiFetch(`/api/v1/admin/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify({ assigned_chat_id: targetChatId || null }),
      });
      setFeedback('Bot channel assignment updated');
      await fetchAdminData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reassign bot');
    }
  };

  const handleDeleteBot = async (b: BotConfig) => {
    setConfirmModal({
      title: `Delete Bot @${b.handle}`,
      message: `Are you sure you want to permanently remove bot "${b.name}"? It will be unassigned from all channels.`,
      actionLabel: 'Delete Bot',
      isDestructive: true,
      onConfirm: async () => {
        await apiFetch(`/api/v1/admin/bots/${b.id}`, { method: 'DELETE' });
        setFeedback(`Bot @${b.handle} deleted`);
        await fetchAdminData();
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-5xl max-h-[92vh] flex flex-col md:flex-row rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] overflow-hidden shadow-2xl">
        
        {/* Left Side Navigation Menu */}
        <div className="md:w-64 shrink-0 border-b md:border-b-0 md:border-e border-slate-200 dark:border-white/10 p-5 flex md:flex-col justify-between gap-4 bg-slate-50/80 dark:bg-[#0B101B]/80">
          <div className="space-y-4 w-full">
            <div className="flex items-center gap-3 pb-2 border-b border-slate-200 dark:border-white/10">
              <div className="w-9 h-9 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500 shrink-0">
                <Shield className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-sm font-bold truncate flex items-center gap-1.5">
                  <span>Super Admin</span>
                  <AdminBadge size="sm" />
                </h2>
                <p className="text-[11px] text-slate-400 truncate">Command Center</p>
              </div>
            </div>

            <nav className="flex md:flex-col gap-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={() => setActiveTab('users')}
                className={`w-full min-h-[44px] px-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                  activeTab === 'users'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/5'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Users & Badges ({users.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('bots')}
                className={`w-full min-h-[44px] px-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                  activeTab === 'bots'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/5'
                }`}
              >
                <Bot className="w-4 h-4" />
                <span>Bot Manager & Prompt Editor ({bots.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('chats')}
                className={`w-full min-h-[44px] px-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                  activeTab === 'chats'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/5'
                }`}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>Groups & Channels ({chats.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('audit')}
                className={`w-full min-h-[44px] px-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                  activeTab === 'audit'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/5'
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>Audit Logs ({auditLogs.length})</span>
              </button>
            </nav>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/15 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/5 flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" />
            <span>Close Console</span>
          </button>
        </div>

        {/* Right Main Content Pane */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between bg-slate-50/50 dark:bg-[#121A2B]">
            <h3 className="font-display text-base font-bold capitalize">
              {activeTab === 'users' && 'User Management & Badge Authority'}
              {activeTab === 'bots' && 'AI Bot Manager & Visual Prompt Editor'}
              {activeTab === 'chats' && 'Group & Channel Moderation'}
              {activeTab === 'audit' && 'System Audit Logs & Moderation History'}
            </h3>
            <span className="text-xs font-mono-tabular text-slate-400">
              Admin: @{currentUser.username}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto slim-scroll p-6 space-y-4">
            {error && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-500 font-medium">
                {error}
              </div>
            )}
            {feedback && (
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-500 font-medium">
                {feedback}
              </div>
            )}

            {/* USERS TAB */}
            {activeTab === 'users' && (
              <div className="space-y-3">
                <div className="p-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/15 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-bold text-indigo-500 dark:text-indigo-400">User Badge & Moderation System</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Toggle Verified or Developer badges instantly. Badges render across the sidebar, header, and message bubbles.
                    </p>
                  </div>
                </div>

                <div className="grid gap-3">
                  {users.map((u) => (
                    <div
                      key={u.id}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={u.display_name} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-sm truncate">{u.display_name}</span>
                            {u.verified_flag === 1 && <VerifiedBadge size="sm" />}
                            {u.developer_badge === 1 && <DeveloperBadge size="sm" />}
                            {u.is_admin === 1 && <AdminBadge size="sm" />}
                            {u.is_banned === 1 && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500">
                                Suspended
                              </span>
                            )}
                            <span className="text-xs text-slate-400">@{u.username}</span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            {u.email} {u.ban_reason ? `· Reason: ${u.ban_reason}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleToggleBadge(u.id, 'verified', u.verified_flag)}
                          className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-colors ${
                            u.verified_flag === 1
                              ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/40'
                              : 'border-slate-200 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
                          }`}
                        >
                          <VerifiedBadge size="sm" />
                          <span>{u.verified_flag === 1 ? 'Unverify' : 'Verify'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleToggleBadge(u.id, 'developer', u.developer_badge)}
                          className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-colors ${
                            u.developer_badge === 1
                              ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/40'
                              : 'border-slate-200 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
                          }`}
                        >
                          <DeveloperBadge size="sm" />
                          <span>{u.developer_badge === 1 ? 'Remove Dev' : 'Dev Badge'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleToggleAdmin(u.id, u.is_admin)}
                          className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border flex items-center gap-1.5 ${
                            u.is_admin === 1
                              ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                              : 'border-amber-500/30 text-amber-500 hover:bg-amber-500/10'
                          }`}
                        >
                          <Shield className="w-3.5 h-3.5" />
                          <span>{u.is_admin === 1 ? 'Revoke Admin' : 'Make Admin'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleBanSuspendUser(u.id, u.is_banned)}
                          className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border ${
                            u.is_banned === 1
                              ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                              : 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                          }`}
                        >
                          {u.is_banned === 1 ? 'Lift Suspension' : 'Suspend / Ban'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* BOTS TAB & PROMPT EDITOR */}
            {activeTab === 'bots' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20">
                  <div>
                    <h3 className="font-display text-sm font-bold flex items-center gap-2">
                      <Bot className="w-4 h-4 text-indigo-500" />
                      <span>AI Bot Manager & Visual Prompt Studio</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Configure custom AI models (Gemini, Llama, custom endpoints), system instructions, and channel assignments.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenCreateBot}
                    className="min-h-[40px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-2 shadow-sm shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Register New Bot</span>
                  </button>
                </div>

                <div className="grid gap-3">
                  {bots.map((b) => (
                    <div
                      key={b.id}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4"
                    >
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm truncate">{b.name}</span>
                          <BotBadge isVerified={b.is_verified} size="sm" />
                          <span className="text-xs font-mono-tabular text-slate-400">@{b.handle}</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-400 uppercase">
                            {b.provider} · {b.model}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                          {b.description || 'AI Bot assistant'}
                        </p>
                        {b.system_instruction && (
                          <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] border border-slate-200 dark:border-white/10 text-[11px] font-mono-tabular text-slate-300">
                            <span className="text-indigo-400 font-bold">Prompt:</span> {b.system_instruction}
                          </div>
                        )}
                        <div className="flex items-center gap-2 flex-wrap text-xs pt-1">
                          <span className="text-slate-400 font-semibold">Assigned Channel:</span>
                          <select
                            value={b.assigned_chat_id || ''}
                            onChange={(e) => void handleReassignBot(b.id, e.target.value)}
                            className="px-2.5 py-1 rounded-lg bg-slate-200/70 dark:bg-[#0B101B] border border-slate-300 dark:border-white/10 text-xs font-semibold"
                          >
                            <option value="">None (Global / Direct AI)</option>
                            {chats.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.title} ({c.type})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleToggleBotVerified(b.id, b.is_verified)}
                          className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border flex items-center gap-1.5 ${
                            b.is_verified
                              ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/40'
                              : 'border-slate-200 dark:border-white/15 text-slate-400'
                          }`}
                        >
                          <VerifiedBadge size="sm" />
                          <span>{b.is_verified ? 'Verified Bot' : 'Verify'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleOpenEditBot(b)}
                          className="min-h-[34px] px-3 rounded-xl text-xs font-semibold border border-slate-200 dark:border-white/15 hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-1.5"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>Prompt Editor</span>
                        </button>

                        {b.id !== 'bot_zephyrix_ai' && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteBot(b)}
                            className="min-h-[34px] px-3 rounded-xl text-xs font-semibold border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 flex items-center gap-1.5"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* GROUPS & CHANNELS TAB */}
            {activeTab === 'chats' && (
              <div className="space-y-3">
                {chats.length === 0 ? (
                  <p className="text-center text-slate-400 py-12">No groups or channels found.</p>
                ) : (
                  chats.map((c) => (
                    <div
                      key={c.id}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm truncate">{c.title}</span>
                          <span className="uppercase text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-400">
                            {c.type}
                          </span>
                          {c.is_banned === 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500">
                              Banned
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 truncate mt-1">
                          Owner: {c.owner_name || 'System'} {c.ban_reason ? `· Ban Reason: ${c.ban_reason}` : ''}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleToggleChatBan(c.id, c.is_banned)}
                        className={`min-h-[36px] px-4 rounded-xl text-xs font-semibold border shrink-0 ${
                          c.is_banned === 1
                            ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                            : 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                        }`}
                      >
                        {c.is_banned === 1 ? 'Unban Channel' : 'Ban Channel'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* AUDIT LOGS TAB */}
            {activeTab === 'audit' && (
              <div className="space-y-3">
                <div className="p-4 rounded-2xl bg-slate-100 dark:bg-[#0B101B] border border-slate-200 dark:border-white/10 flex items-center justify-between">
                  <div>
                    <h4 className="font-display text-xs font-bold text-slate-300 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-indigo-500" />
                      <span>Security & Moderation Audit Trail</span>
                    </h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      All admin privilege changes, bans, bot registrations, and badge toggles are permanently recorded.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  {auditLogs.length === 0 ? (
                    <p className="text-center text-slate-400 py-12">No audit logs recorded yet.</p>
                  ) : (
                    auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="p-3.5 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono-tabular font-bold px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-400">
                              {log.action}
                            </span>
                            <span className="font-semibold">By: {log.admin_name} (@{log.admin_username})</span>
                          </div>
                          <p className="text-[11px] text-slate-400 font-mono-tabular truncate">
                            Target ID: {log.target_id} · Details: {log.details || 'N/A'}
                          </p>
                        </div>
                        <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                          {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* BOT REGISTER / PROMPT EDITOR MODAL */}
      {showBotModal && (
        <div className="fixed inset-0 z-60 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#162035] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-500" />
                <span>{editingBot ? 'Visual Prompt Editor & Bot Settings' : 'Register Custom AI Bot'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowBotModal(false)}
                className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveBot} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-400">Bot Name *</span>
                  <input
                    type="text"
                    required
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="e.g. Zephyrix Code Specialist"
                    className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-400">Bot Handle *</span>
                  <input
                    type="text"
                    required
                    value={botHandle}
                    onChange={(e) => setBotHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    placeholder="e.g. code_specialist"
                    className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs font-mono-tabular border border-slate-200 dark:border-white/10"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-400">AI Provider / Engine</span>
                  <select
                    value={botProvider}
                    onChange={(e) => setBotProvider(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                  >
                    <option value="gemini">Google Gemini SDK (Hydrogen / Flash)</option>
                    <option value="custom">Custom REST Endpoint</option>
                    <option value="openai">OpenAI Compatible (GPT / Llama)</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-400">Model Name</span>
                  <input
                    type="text"
                    required
                    value={botModel}
                    onChange={(e) => setBotModel(e.target.value)}
                    placeholder="e.g. gemini-4-hydrogen"
                    className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs font-mono-tabular border border-slate-200 dark:border-white/10"
                  />
                </label>
              </div>

              {botProvider !== 'gemini' && (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-400">API Endpoint URL</span>
                    <input
                      type="url"
                      value={botEndpoint}
                      onChange={(e) => setBotEndpoint(e.target.value)}
                      placeholder="https://api.yourcustomendpoint.com/v1/chat"
                      className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs font-mono-tabular border border-slate-200 dark:border-white/10"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-400">API Key / Token (optional)</span>
                    <input
                      type="password"
                      value={botApiKey}
                      onChange={(e) => setBotApiKey(e.target.value)}
                      placeholder="Bearer token or API Key"
                      className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs font-mono-tabular border border-slate-200 dark:border-white/10"
                    />
                  </label>
                </>
              )}

              {/* Visual Prompt Editor Section */}
              <div className="p-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/20 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-display text-xs font-bold text-indigo-400 flex items-center gap-1.5">
                    <Terminal className="w-4 h-4" />
                    <span>Visual Prompt Editor & System Instruction</span>
                  </h4>
                  <span className="text-[10px] font-mono-tabular text-slate-400">Live AI System Persona</span>
                </div>
                <textarea
                  rows={4}
                  value={botSystemInstruction}
                  onChange={(e) => setBotSystemInstruction(e.target.value)}
                  placeholder="Define persona, rules, markdown formatting, and response constraints..."
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-[#0B101B] text-xs font-mono-tabular border border-slate-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />

                {/* Prompt Sandbox Testing */}
                <div className="pt-2 border-t border-indigo-500/15 space-y-2">
                  <p className="text-[11px] font-semibold text-slate-300">Test Prompt Sandbox Preview</p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={testPrompt}
                      onChange={(e) => setTestPrompt(e.target.value)}
                      placeholder="Ask bot a test question..."
                      className="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                    />
                    <button
                      type="button"
                      disabled={testingPrompt}
                      onClick={() => void handleTestPromptSandbox()}
                      className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shrink-0"
                    >
                      {testingPrompt ? 'Testing...' : 'Run Test'}
                    </button>
                  </div>
                  {testResponse && (
                    <div className="p-3 rounded-xl bg-white dark:bg-[#0B101B] border border-slate-200 dark:border-white/10 text-xs font-mono-tabular text-slate-200 max-h-28 overflow-y-auto">
                      <span className="text-emerald-400 font-bold">Bot Reply:</span> {testResponse}
                    </div>
                  )}
                </div>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-semibold text-slate-400">Assign to Group or Channel</span>
                <select
                  value={botAssignedChatId}
                  onChange={(e) => setBotAssignedChatId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                >
                  <option value="">None (Global AI Assistant)</option>
                  {chats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} ({c.type})
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={botIsVerified}
                  onChange={(e) => setBotIsVerified(e.target.checked)}
                  className="w-4 h-4 accent-cyan-500"
                />
                <span className="text-xs font-semibold flex items-center gap-1.5">
                  <span>Display 'Verified' Bot Badge</span>
                  <VerifiedBadge size="sm" />
                </span>
              </label>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBotModal(false)}
                  className="flex-1 min-h-[42px] rounded-xl border border-slate-200 dark:border-white/15 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBot}
                  className="flex-1 min-h-[42px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  {savingBot ? 'Saving...' : editingBot ? 'Update Bot & Prompt' : 'Register Bot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIRMATION MODAL */}
      {confirmModal && (
        <div className="fixed inset-0 z-70 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#162035] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/15 text-rose-500 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-display text-base font-bold">{confirmModal.title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">Please confirm your action</p>
              </div>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-[#0B101B] p-3 rounded-2xl border border-slate-200 dark:border-white/10">
              {confirmModal.message}
            </p>
            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="flex-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-white/15 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await confirmModal.onConfirm();
                    setConfirmModal(null);
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : 'Action failed');
                    setConfirmModal(null);
                  }
                }}
                className={`flex-1 min-h-[44px] rounded-xl text-xs font-semibold text-white ${
                  confirmModal.isDestructive ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'
                }`}
              >
                {confirmModal.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

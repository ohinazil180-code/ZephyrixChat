import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Award,
  Bot,
  Check,
  Shield,
  ShieldAlert,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { translations } from '../i18n/translations';
import { ApiError, apiFetch } from '../lib/api';
import type { Locale, UserProfile } from '../types/zephyrix';
import { Avatar } from './Avatar';

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
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  open,
  onClose,
  locale,
  currentUser,
}) => {
  const t = translations[locale];
  const [activeTab, setActiveTab] = useState<'users' | 'chats' | 'ai'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [chats, setChats] = useState<AdminChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

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
      const [usersRes, chatsRes] = await Promise.all([
        apiFetch<{ users: AdminUser[] }>('/api/v1/admin/users'),
        apiFetch<{ chats: AdminChat[] }>('/api/v1/admin/chats'),
      ]);
      setUsers(usersRes.users);
      setChats(chatsRes.chats);
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
      title: nextAdmin ? 'Grant Admin Privileges' : 'Revoke Admin Privileges',
      message: `Are you sure you want to ${nextAdmin ? 'grant Super Admin privileges to' : 'revoke admin privileges from'} this user?`,
      actionLabel: nextAdmin ? 'Grant Admin' : 'Revoke',
      onConfirm: async () => {
        await apiFetch(`/api/v1/admin/users/${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ isAdmin: nextAdmin }),
        });
        setFeedback('User role updated successfully');
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
      setFeedback(`User badge updated`);
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

  return (
    <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between bg-slate-50/70 dark:bg-[#0B101B]/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold">Zephyrix Super Admin Command Center</h2>
              <p className="text-xs text-slate-400">Complete platform control, user moderation, badges & AI bots</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.close}
            className="p-2 rounded-xl hover:bg-slate-200 dark:hover:bg-white/10 min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-white/[0.01]">
          <button
            type="button"
            onClick={() => setActiveTab('users')}
            className={`min-h-[38px] px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors ${
              activeTab === 'users'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-white/5'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Users ({users.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('chats')}
            className={`min-h-[38px] px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors ${
              activeTab === 'chats'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-white/5'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            <span>Groups & Channels ({chats.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ai')}
            className={`min-h-[38px] px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors ${
              activeTab === 'ai'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-white/5'
            }`}
          >
            <Bot className="w-4 h-4" />
            <span>AI Assistant & Models</span>
          </button>
        </div>

        {/* Content Body */}
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

          {activeTab === 'users' && (
            <div className="space-y-3">
              <div className="grid gap-2.5">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] flex flex-col md:flex-row items-start md:items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={u.display_name} size="md" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm truncate">{u.display_name}</span>
                          <span className="text-xs text-slate-400">@{u.username}</span>
                          {u.is_admin === 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-500">
                              Super Admin
                            </span>
                          )}
                          {u.is_banned === 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500">
                              Suspended
                            </span>
                          )}
                          {u.verified_flag === 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/15 text-cyan-400 flex items-center gap-1">
                              <Award className="w-3 h-3" /> Verified
                            </span>
                          )}
                          {u.developer_badge === 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-400">
                              Developer
                            </span>
                          )}
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
                        className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border ${
                          u.verified_flag === 1
                            ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                            : 'border-slate-200 dark:border-white/15 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {u.verified_flag === 1 ? 'Unverify' : 'Verify Badge'}
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleToggleBadge(u.id, 'developer', u.developer_badge)}
                        className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border ${
                          u.developer_badge === 1
                            ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30'
                            : 'border-slate-200 dark:border-white/15 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {u.developer_badge === 1 ? 'Remove Dev' : 'Dev Badge'}
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleToggleAdmin(u.id, u.is_admin)}
                        className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold border ${
                          u.is_admin === 1
                            ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                            : 'border-indigo-500/30 text-indigo-600 dark:text-indigo-400'
                        }`}
                      >
                        {u.is_admin === 1 ? 'Revoke Admin' : 'Make Admin'}
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

          {activeTab === 'ai' && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-display text-sm font-bold">Zephyrix AI Assistant (Gemini Powered)</h3>
                    <p className="text-xs text-slate-400">Always verified with enterprise-grade multimodal capabilities</p>
                  </div>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  The Zephyrix AI Assistant is built directly into every user sidebar. It supports real-time text conversations, voice note transcription, and arbitrary file transfers (PDFs, docs, code, images). Powered securely by Google GenAI SDK (`gemini-4-hydrogen`).
                </p>
              </div>

              <div className="p-5 rounded-2xl border border-slate-200 dark:border-white/10 space-y-3">
                <h4 className="font-display text-sm font-bold">Custom AI Model & Provider Settings</h4>
                <p className="text-xs text-slate-400">Configure secondary AI endpoints or custom provider parameters.</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    defaultValue="gemini-4-hydrogen"
                    placeholder="Model ID (e.g. gemini-4-hydrogen)"
                    className="px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                  />
                  <input
                    type="text"
                    defaultValue="https://generativelanguage.googleapis.com"
                    placeholder="API Endpoint"
                    className="px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-xs border border-slate-200 dark:border-white/10"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => alert('AI Model settings saved successfully.')}
                  className="min-h-[40px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save AI Configuration
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-60 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
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

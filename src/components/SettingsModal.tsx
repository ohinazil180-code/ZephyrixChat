import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Download,
  Globe,
  Laptop,
  Lock,
  LogOut,
  Moon,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { formatDateDivider, translations } from '../i18n/translations';
import { ApiError, apiFetch, uploadMediaFile } from '../lib/api';
import type { Locale, SessionInfo, ThemeMode, UserProfile } from '../types/zephyrix';
import { Avatar } from './Avatar';
import { AdminBadge, DeveloperBadge, VerifiedBadge } from './Badges';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  user: UserProfile;
  onUserUpdated: (user: UserProfile) => void;
  onLoggedOut: () => void;
  locale: Locale;
  onLocaleChange: (loc: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  rtlPreview: boolean;
  onRtlPreviewChange: (v: boolean) => void;
  reduceMotion: boolean;
  onReduceMotionChange: (v: boolean) => void;
  onOpenAdminPanel?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  user,
  onUserUpdated,
  onLoggedOut,
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  rtlPreview,
  onRtlPreviewChange,
  reduceMotion,
  onReduceMotionChange,
  onOpenAdminPanel,
}) => {
  const t = translations[locale];
  const [tab, setTab] = useState<'profile' | 'appearance' | 'sessions' | 'blocks' | 'privacy' | 'admin'>('profile');

  const [displayName, setDisplayName] = useState(user.display_name);
  const [username, setUsername] = useState(user.username || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [country, setCountry] = useState(user.country || '');
  const [bio, setBio] = useState(user.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || '');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [blocks, setBlocks] = useState<Array<{ id: string; username: string | null; display_name: string }>>([]);
  const [adminUsers, setAdminUsers] = useState<Array<{ id: string; email: string; username: string; display_name: string; is_admin: number; is_banned: number; ban_reason?: string }>>([]);
  const [adminChats, setAdminChats] = useState<Array<{ id: string; type: string; title: string; is_banned: number; ban_reason?: string; owner_name?: string }>>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const handleToggleUserAdmin = async (targetId: string, currentAdmin: number) => {
    try {
      await apiFetch(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin: currentAdmin === 0 }),
      });
      const res = await apiFetch<{ users: typeof adminUsers }>('/api/v1/admin/users');
      setAdminUsers(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  };

  const handleToggleUserBan = async (targetId: string, currentBanned: number) => {
    let reason = '';
    if (currentBanned === 0) {
      const promptRes = window.prompt(t.banReasonPrompt, 'Violation of community standards');
      if (promptRes === null) return;
      reason = promptRes.trim();
    }
    try {
      await apiFetch(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isBanned: currentBanned === 0, banReason: reason }),
      });
      const res = await apiFetch<{ users: typeof adminUsers }>('/api/v1/admin/users');
      setAdminUsers(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  };

  const handleToggleChatBan = async (chatId: string, currentBanned: number) => {
    let reason = '';
    if (currentBanned === 0) {
      const promptRes = window.prompt(t.banReasonPrompt, 'Group/Channel guidelines violation');
      if (promptRes === null) return;
      reason = promptRes.trim();
    }
    try {
      await apiFetch(`/api/v1/admin/chats/${chatId}/ban`, {
        method: 'PATCH',
        body: JSON.stringify({ isBanned: currentBanned === 0, banReason: reason }),
      });
      const res = await apiFetch<{ chats: typeof adminChats }>('/api/v1/admin/chats');
      setAdminChats(res.chats);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  };

  useEffect(() => {
    setDisplayName(user.display_name);
    setUsername(user.username || '');
    setPhone(user.phone || '');
    setCountry(user.country || '');
    setBio(user.bio || '');
    setAvatarUrl(user.avatar_url || '');
  }, [user]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFeedback(null);
    if (tab === 'sessions') {
      apiFetch<{ sessions: SessionInfo[] }>('/api/v1/auth/sessions')
        .then((res) => setSessions(res.sessions))
        .catch(() => {});
    }
    if (tab === 'blocks') {
      apiFetch<{ blocks: Array<{ id: string; username: string | null; display_name: string }> }>('/api/v1/blocks')
        .then((res) => setBlocks(res.blocks))
        .catch(() => {});
    }
    if (tab === 'admin' && user.is_admin) {
      Promise.all([
        apiFetch<{ users: typeof adminUsers }>('/api/v1/admin/users').catch(() => ({ users: [] })),
        apiFetch<{ chats: typeof adminChats }>('/api/v1/admin/chats').catch(() => ({ chats: [] })),
      ]).then(([usersRes, chatsRes]) => {
        setAdminUsers(usersRes.users);
        setAdminChats(chatsRes.chats);
      });
    }
  }, [open, tab, user.is_admin]);

  if (!open) return null;

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{ user: UserProfile }>('/api/v1/me', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: displayName.trim(),
          username: username.trim().toLowerCase().replace(/^@/, ''),
          phone: phone.trim(),
          country: country.trim(),
          bio: bio.trim(),
          avatarUrl: avatarUrl.trim() || null,
          preferredLocale: locale,
        }),
      });
      onUserUpdated(res.user);
      setFeedback('Profile updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setFeedback(null);
    setUploadingAvatar(true);
    try {
      const att = await uploadMediaFile(file);
      const patched = await apiFetch<{ user: UserProfile }>('/api/v1/me', {
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl: att.url }),
      });
      setAvatarUrl(att.url);
      onUserUpdated(patched.user);
      setFeedback('Avatar updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.uploadError);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    try {
      await apiFetch('/api/v1/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setFeedback('Password updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Password update failed.');
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    await apiFetch(`/api/v1/auth/sessions/${sessionId}`, { method: 'DELETE' });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  const handleRevokeOthers = async () => {
    await apiFetch('/api/v1/auth/sessions/revoke-others', { method: 'POST' });
    setSessions((prev) => prev.filter((s) => s.isCurrent));
  };

  const handleUnblock = async (id: string) => {
    await apiFetch(`/api/v1/blocks/${id}`, { method: 'DELETE' });
    setBlocks((prev) => prev.filter((b) => b.id !== id));
  };

  const handleExport = async () => {
    const data = await apiFetch<Record<string, unknown>>('/api/v1/me/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zephyrix-export-${user.username || 'user'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteAccount = async () => {
    await apiFetch('/api/v1/me', { method: 'DELETE' });
    onLoggedOut();
  };

  const handleLogout = async () => {
    await apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    onLoggedOut();
  };

  const navItems: Array<{ id: typeof tab; label: string; icon: React.ReactNode }> = [
    { id: 'profile', label: t.profileSection, icon: <User className="w-4 h-4" /> },
    { id: 'appearance', label: t.appearanceSection, icon: <SlidersHorizontal className="w-4 h-4" /> },
    { id: 'sessions', label: t.sessionsSection, icon: <Laptop className="w-4 h-4" /> },
    { id: 'blocks', label: t.blocksSection, icon: <ShieldAlert className="w-4 h-4" /> },
    { id: 'privacy', label: t.privacySection, icon: <Lock className="w-4 h-4" /> },
    ...(user.is_admin
      ? [{ id: 'admin' as const, label: t.adminConsole, icon: <ShieldAlert className="w-4 h-4 text-amber-500" /> }]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col md:flex-row rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#121A2B] overflow-hidden shadow-2xl">
        {/* Left Settings Nav */}
        <div className="md:w-56 shrink-0 border-b md:border-b-0 md:border-e border-slate-200 dark:border-white/10 p-4 flex md:flex-col justify-between gap-2 overflow-x-auto bg-slate-50/70 dark:bg-[#0B101B]/60">
          <div className="flex md:flex-col gap-1.5">
            <h2 className="hidden md:block font-display text-lg font-bold px-2 pb-3">{t.settings}</h2>
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`min-h-[44px] px-3 rounded-xl flex items-center gap-2.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                  tab === item.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/5'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleLogout()}
            className="min-h-[44px] px-3 rounded-xl flex items-center gap-2 text-xs font-semibold text-rose-500 hover:bg-rose-500/10 whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            <span>{t.logout}</span>
          </button>
        </div>

        {/* Content Pane */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
            <h3 className="font-display text-base font-bold">
              {navItems.find((n) => n.id === tab)?.label}
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

          <div className="flex-1 overflow-y-auto slim-scroll p-6 space-y-5">
            {error && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 px-4 py-2.5 text-xs text-rose-500 font-medium">
                {error}
              </div>
            )}
            {feedback && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-2.5 text-xs text-emerald-500 font-medium">
                {feedback}
              </div>
            )}

            {tab === 'profile' && (
              <form onSubmit={handleSaveProfile} className="space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar name={displayName || user.display_name} src={avatarUrl || null} size="xl" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display text-sm font-bold">{user.display_name}</span>
                      {user.is_admin && <AdminBadge />}
                      {user.verified_flag && <VerifiedBadge />}
                      {user.developer_badge && <DeveloperBadge />}
                    </div>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={handleAvatarUpload}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={uploadingAvatar}
                        onClick={() => avatarInputRef.current?.click()}
                        className="min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-white/15 inline-flex items-center gap-2 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-white/5"
                      >
                        <Camera className="w-4 h-4 text-indigo-500" />
                        <span>{uploadingAvatar ? t.uploadingLabel : t.avatarChangeBtn}</span>
                      </button>
                      <p className="text-[11px] text-slate-400">{user.email}</p>
                    </div>
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-500">{t.fullNameLabel}</span>
                    <input
                      type="text"
                      required
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-500">{t.usernameLabel}</span>
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm font-mono-tabular border border-slate-200 dark:border-white/10"
                    />
                  </label>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-500">{t.phoneLabel}</span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-500">{t.countryLabel}</span>
                    <input
                      type="text"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-500">{t.bioLabel}</span>
                  <textarea
                    rows={3}
                    maxLength={240}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                  />
                </label>

                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[44px] px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold"
                >
                  {t.saveProfile}
                </button>
              </form>
            )}

            {tab === 'appearance' && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t.languageLabel}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onLocaleChange('en')}
                      className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold border ${
                        locale === 'en'
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'border-slate-200 dark:border-white/10'
                      }`}
                    >
                      <Globe className="w-3.5 h-3.5 inline me-1" /> English
                    </button>
                    <button
                      type="button"
                      onClick={() => onLocaleChange('bn')}
                      className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold border ${
                        locale === 'bn'
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'border-slate-200 dark:border-white/10'
                      }`}
                    >
                      বাংলা
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t.themeLabel}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onThemeChange('dark')}
                      className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold border inline-flex items-center gap-1.5 ${
                        theme === 'dark'
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'border-slate-200 dark:border-white/10'
                      }`}
                    >
                      <Moon className="w-3.5 h-3.5" /> {t.darkTheme}
                    </button>
                    <button
                      type="button"
                      onClick={() => onThemeChange('light')}
                      className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold border inline-flex items-center gap-1.5 ${
                        theme === 'light'
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'border-slate-200 dark:border-white/10'
                      }`}
                    >
                      <Sun className="w-3.5 h-3.5" /> {t.lightTheme}
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-medium">{t.rtlLabel}</span>
                  <input
                    type="checkbox"
                    checked={rtlPreview}
                    onChange={(e) => onRtlPreviewChange(e.target.checked)}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>

                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-medium">{t.reduceMotionLabel}</span>
                  <input
                    type="checkbox"
                    checked={reduceMotion}
                    onChange={(e) => onReduceMotionChange(e.target.checked)}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>

                <div className="pt-2">
                  <PWAInstallButton locale={locale} />
                </div>
              </div>
            )}

            {tab === 'sessions' && (
              <div className="space-y-4">
                {sessions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void handleRevokeOthers()}
                    className="min-h-[40px] px-4 rounded-xl bg-rose-500/15 text-rose-500 text-xs font-semibold"
                  >
                    {t.revokeOthers}
                  </button>
                )}
                <div className="space-y-2.5">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className="p-3.5 rounded-2xl border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {s.device_label}{' '}
                          {s.isCurrent && (
                            <span className="text-[11px] font-semibold text-emerald-500 ms-1">· Current</span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400">
                          {formatDateDivider(s.last_seen_at, locale)}
                        </p>
                      </div>
                      {!s.isCurrent && (
                        <button
                          type="button"
                          onClick={() => void handleRevokeSession(s.id)}
                          className="min-h-[36px] px-3 rounded-xl bg-rose-500/15 text-rose-500 text-xs font-semibold"
                        >
                          {t.revokeSession}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'blocks' && (
              <div className="space-y-2.5">
                {blocks.length === 0 ? (
                  <p className="text-sm text-slate-400">No blocked users.</p>
                ) : (
                  blocks.map((b) => (
                    <div
                      key={b.id}
                      className="p-3 rounded-2xl border border-slate-200 dark:border-white/10 flex items-center justify-between"
                    >
                      <div>
                        <p className="text-sm font-semibold">{b.display_name}</p>
                        <p className="text-xs text-slate-400">@{b.username}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleUnblock(b.id)}
                        className="min-h-[36px] px-3 rounded-xl bg-emerald-500/15 text-emerald-500 text-xs font-semibold"
                      >
                        {t.unblock}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === 'privacy' && (
              <div className="space-y-6">
                <form onSubmit={handleChangePassword} className="space-y-3 p-4 rounded-2xl border border-slate-200 dark:border-white/10">
                  <h4 className="font-display text-sm font-bold">{t.changePasswordTitle}</h4>
                  <input
                    type="password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder={t.currentPasswordLabel}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                  />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t.newPasswordLabel}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0B101B] text-sm border border-slate-200 dark:border-white/10"
                  />
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                  >
                    {t.updatePasswordBtn}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={() => void handleExport()}
                  className="w-full min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-white/15 flex items-center justify-center gap-2 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-white/5"
                >
                  <Download className="w-4 h-4 text-indigo-500" />
                  <span>{t.exportData}</span>
                </button>

                <div className="pt-4 border-t border-slate-200 dark:border-white/10 space-y-3">
                  {!confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="w-full min-h-[44px] px-4 rounded-xl bg-rose-500/10 text-rose-500 text-sm font-semibold flex items-center justify-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>{t.deleteAccount}</span>
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="flex-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-white/15 text-xs font-semibold"
                      >
                        {t.cancel}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteAccount()}
                        className="flex-1 min-h-[44px] rounded-xl bg-rose-600 text-white text-xs font-semibold"
                      >
                        {t.deleteAccountConfirm}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'admin' && user.is_admin && (
              <div className="space-y-6">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAdminPanel?.();
                  }}
                  className="w-full min-h-[48px] px-5 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 text-white font-display text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-amber-500/25 hover:opacity-95 transition-opacity"
                >
                  <ShieldAlert className="w-5 h-5" />
                  <span>Open Full Super Admin Command Center</span>
                </button>

                <div className="space-y-3">
                  <h4 className="font-display text-sm font-bold flex items-center gap-2">
                    <User className="w-4 h-4 text-indigo-500" />
                    <span>{t.userManagement} ({adminUsers.length})</span>
                  </h4>
                  <div className="space-y-2 max-h-60 overflow-y-auto slim-scroll pr-1">
                    {adminUsers.map((u) => (
                      <div key={u.id} className="p-3 rounded-2xl border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-white/[0.02]">
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate">
                            {u.display_name}{' '}
                            <span className="font-normal text-slate-400">@{u.username}</span>
                            {u.is_admin === 1 && (
                              <span className="ms-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-500">Admin</span>
                            )}
                            {u.is_banned === 1 && (
                              <span className="ms-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500">Banned</span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">{u.email} {u.ban_reason ? `· ${u.ban_reason}` : ''}</p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handleToggleUserAdmin(u.id, u.is_admin)}
                            className={`min-h-[32px] px-2.5 rounded-lg text-[11px] font-semibold border ${
                              u.is_admin === 1
                                ? 'border-amber-500/30 text-amber-500 hover:bg-amber-500/10'
                                : 'border-indigo-500/30 text-indigo-500 hover:bg-indigo-500/10'
                            }`}
                          >
                            {u.is_admin === 1 ? t.revokeAdmin : t.makeAdmin}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleUserBan(u.id, u.is_banned)}
                            className={`min-h-[32px] px-2.5 rounded-lg text-[11px] font-semibold border ${
                              u.is_banned === 1
                                ? 'border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10'
                                : 'border-rose-500/30 text-rose-500 hover:bg-rose-500/10'
                            }`}
                          >
                            {u.is_banned === 1 ? t.unbanUser : t.banUser}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-white/10">
                  <h4 className="font-display text-sm font-bold flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-500" />
                    <span>{t.channelManagement} ({adminChats.length})</span>
                  </h4>
                  <div className="space-y-2 max-h-60 overflow-y-auto slim-scroll pr-1">
                    {adminChats.map((c) => (
                      <div key={c.id} className="p-3 rounded-2xl border border-slate-200 dark:border-white/10 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-white/[0.02]">
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate">
                            {c.title}{' '}
                            <span className="uppercase text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 ms-1">{c.type}</span>
                            {c.is_banned === 1 && (
                              <span className="ms-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500">Banned</span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">Owner: {c.owner_name || 'Unknown'} {c.ban_reason ? `· ${c.ban_reason}` : ''}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleToggleChatBan(c.id, c.is_banned)}
                          className={`min-h-[32px] px-2.5 rounded-lg text-[11px] font-semibold border shrink-0 ${
                            c.is_banned === 1
                              ? 'border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10'
                              : 'border-rose-500/30 text-rose-500 hover:bg-rose-500/10'
                          }`}
                        >
                          {c.is_banned === 1 ? t.unbanUser : t.banUser}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

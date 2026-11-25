import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Camera,
  Check,
  Eye,
  EyeOff,
  Globe,
  Lock,
  Mail,
  MapPin,
  Moon,
  Phone,
  RotateCcw,
  Shield,
  Sun,
  Trash2,
  UploadCloud,
  User,
  Video,
  XCircle,
  ZoomIn,
} from 'lucide-react';
import { formatNumber, translations } from '../i18n/translations';
import { ApiError, apiFetch, setInMemoryToken, uploadMediaFile } from '../lib/api';
import type { Locale, ThemeMode, UserProfile } from '../types/zephyrix';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthScreenProps {
  locale: Locale;
  onLocaleChange: (loc: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  reduceMotion?: boolean;
  onAuthenticated: (user: UserProfile) => void;
}

const CROP_RING_PX = 112;
const EXPORT_AVATAR_PX = 512;

async function exportCroppedAvatarFile(
  imageSrc: string,
  fileName: string,
  zoom: number,
  offsetX: number,
  offsetY: number
): Promise<File> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = imageSrc;
  });

  const canvas = document.createElement('canvas');
  canvas.width = EXPORT_AVATAR_PX;
  canvas.height = EXPORT_AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }

  const baseScale = Math.max(CROP_RING_PX / img.naturalWidth, CROP_RING_PX / img.naturalHeight);
  const ratio = EXPORT_AVATAR_PX / CROP_RING_PX;
  const drawW = img.naturalWidth * baseScale * zoom * ratio;
  const drawH = img.naturalHeight * baseScale * zoom * ratio;
  const drawX = (EXPORT_AVATAR_PX - drawW) / 2 + offsetX * ratio;
  const drawY = (EXPORT_AVATAR_PX - drawH) / 2 + offsetY * ratio;

  ctx.clearRect(0, 0, EXPORT_AVATAR_PX, EXPORT_AVATAR_PX);
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else canvas.toBlob(resolve, 'image/png');
      },
      'image/webp',
      0.9
    );
  });

  if (!blob) {
    throw new Error('Failed to render cropped avatar');
  }

  const cleanBase = fileName.replace(/\.[^.]+$/, '') || 'avatar';
  const ext = blob.type === 'image/png' ? 'png' : 'webp';
  return new File([blob], `${cleanBase}.${ext}`, { type: blob.type });
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  reduceMotion = false,
  onAuthenticated,
}) => {
  const t = translations[locale];
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [signupStep, setSignupStep] = useState<1 | 2>(1);
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  // Subtle 3D glass pointer tilt state
  const [tilt, setTilt] = useState<{ rx: number; ry: number }>({ rx: 0, ry: 0 });

  // Sign In state
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Sign Up Step 1: Credentials
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showSignupPass, setShowSignupPass] = useState(false);

  // Sign Up Step 2: Profile Identity & Drag-and-Drop Avatar Cropper
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [bio, setBio] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1.1);
  const [cropOffset, setCropOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const dragOriginRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
    };
  }, [avatarPreviewUrl]);

  useEffect(() => {
    if (mode !== 'signup' || signupStep !== 2) return;
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    if (!clean) {
      setUsernameStatus('idle');
      return;
    }
    if (!/^[a-z0-9_]{3,32}$/.test(clean)) {
      setUsernameStatus('invalid');
      return;
    }
    setUsernameStatus('checking');
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ valid: boolean; available: boolean }>(
          `/api/v1/auth/username-check?username=${encodeURIComponent(clean)}`
        );
        if (!res.valid) setUsernameStatus('invalid');
        else setUsernameStatus(res.available ? 'available' : 'taken');
      } catch {
        setUsernameStatus('idle');
      }
    }, 240);
    return () => window.clearTimeout(timer);
  }, [username, mode, signupStep]);

  const loadAvatarFile = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    setAvatarFile(file);
    setAvatarPreviewUrl(URL.createObjectURL(file));
    setCropZoom(1.1);
    setCropOffset({ x: 0, y: 0 });
  };

  const handleSelectAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    loadAvatarFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const handleDropAvatar = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    loadAvatarFile(file);
  };

  const handleRemoveAvatar = () => {
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setCropZoom(1.1);
    setCropOffset({ x: 0, y: 0 });
  };

  const handleCropPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!avatarPreviewUrl) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingCrop(true);
    dragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: cropOffset.x,
      startY: cropOffset.y,
    };
  };

  const handleCropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingCrop || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.x;
    const dy = e.clientY - dragOriginRef.current.y;
    const maxPan = Math.round(48 * cropZoom);
    setCropOffset({
      x: Math.max(-maxPan, Math.min(maxPan, dragOriginRef.current.startX + dx)),
      y: Math.max(-maxPan, Math.min(maxPan, dragOriginRef.current.startY + dy)),
    });
  };

  const handleCropPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingCrop) return;
    setIsDraggingCrop(false);
    dragOriginRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleGlassPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduceMotion || e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({
      rx: Number((-py * 2.2).toFixed(2)),
      ry: Number((px * 2.4).toFixed(2)),
    });
  };

  const handleGlassPointerLeave = () => {
    setTilt({ rx: 0, ry: 0 });
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserProfile }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: identifier.trim(),
          password: loginPassword,
        }),
      });
      setInMemoryToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  const handleAdvanceToStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError(t.authInvalidEmail);
      return;
    }
    if (password.length < 6) {
      setError(t.authWeakPassword);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.passwordsMismatch);
      return;
    }

    setSignupStep(2);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t.passwordsMismatch);
      setSignupStep(1);
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserProfile }>('/api/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          displayName: displayName.trim(),
          username: username.trim().toLowerCase().replace(/^@/, ''),
          email: email.trim().toLowerCase(),
          password,
          phone: phone.trim(),
          country: country.trim(),
          bio: bio.trim(),
          preferredLocale: locale,
        }),
      });

      setInMemoryToken(res.token);
      let finalUser = res.user;

      if (avatarFile && avatarPreviewUrl) {
        try {
          const croppedFile = await exportCroppedAvatarFile(
            avatarPreviewUrl,
            avatarFile.name,
            cropZoom,
            cropOffset.x,
            cropOffset.y
          );
          const uploaded = await uploadMediaFile(croppedFile);
          const patched = await apiFetch<{ user: UserProfile }>('/api/v1/me', {
            method: 'PATCH',
            body: JSON.stringify({ avatarUrl: uploaded.url }),
          });
          finalUser = patched.user;
        } catch {
          // Account created; avatar can also be updated in Settings if upload fails
        }
      }

      onAuthenticated(finalUser);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create account.');
    } finally {
      setLoading(false);
    }
  };

  const passwordStrength = password.length === 0 ? 0 : password.length < 6 ? 1 : password.length < 10 ? 2 : 3;
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

  return (
    <div className="min-h-screen w-full relative overflow-x-hidden bg-[#F2F5FA] dark:bg-[#070B14] text-slate-900 dark:text-slate-100 flex flex-col zephyrix-bg">
      {/* Top Bar */}
      <header className="relative z-10 w-full max-w-7xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between gap-8">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="Zephyrix" className="w-8 h-8 rounded-xl" />
          <span className="font-display text-lg font-bold tracking-tight">{t.brand}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton locale={locale} />
          <button
            type="button"
            onClick={() => onLocaleChange(locale === 'en' ? 'bn' : 'en')}
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white/80 dark:bg-[#101726]/80 backdrop-blur-md text-xs font-semibold flex items-center gap-1.5 hover:bg-white dark:hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
          >
            <Globe className="w-3.5 h-3.5 text-indigo-500" />
            <span>{locale === 'en' ? 'বাংলা' : 'EN'}</span>
          </button>
          <button
            type="button"
            onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
            className="min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-white/10 bg-white/80 dark:bg-[#101726]/80 backdrop-blur-md flex items-center justify-center hover:bg-white dark:hover:bg-white/10 transition-colors shrink-0"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
          </button>
        </div>
      </header>

      {/* Main Split Workspace */}
      <main className="relative z-10 flex-1 w-full max-w-7xl mx-auto px-5 sm:px-8 pb-8 pt-2 grid lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Architectural Obsidian Hero Panel */}
        <section className="hidden lg:flex lg:col-span-6 relative rounded-3xl overflow-hidden border border-slate-200 dark:border-white/12 bg-[#070B14] text-white min-h-[620px] flex-col justify-between p-10 shadow-2xl shadow-slate-950/20">
          {!heroImgFailed && (
            <img
              src="/src/assets/images/zephyrix_auth_hero_1795359942502.jpg"
              alt="Zephyrix Glass Architecture"
              referrerPolicy="no-referrer"
              onError={() => setHeroImgFailed(true)}
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-[#060911]/95 via-[#060911]/55 to-[#060911]/30"
          />

          <div className="relative z-10 flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl overflow-hidden border border-white/20 bg-white/10 backdrop-blur-xl shadow-lg">
              <img
                src="/src/assets/images/zephyrix_splash_emblem_1795359941658.jpg"
                alt="Zephyrix Emblem"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <span className="font-display text-xl font-bold tracking-tight">Zephyrix</span>
          </div>

          <div className="relative z-10 space-y-6 max-w-lg">
            <div className="space-y-3">
              <h2 className="font-display text-3xl xl:text-4xl font-bold leading-tight text-balance">
                {t.authHeroHeadline}
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed">{t.authHeroSub}</p>
            </div>

            <div className="pt-5 border-t border-white/15 grid grid-cols-1 gap-3 text-sm text-slate-200">
              <div className="flex items-center gap-3">
                <Camera className="w-4 h-4 text-sky-400 shrink-0" />
                <span>{t.authHighlight1}</span>
              </div>
              <div className="flex items-center gap-3">
                <Video className="w-4 h-4 text-sky-400 shrink-0" />
                <span>{t.authHighlight2}</span>
              </div>
              <div className="flex items-center gap-3">
                <Shield className="w-4 h-4 text-sky-400 shrink-0" />
                <span>{t.authHighlight3}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Right Obsidian Frosted 3D Glass Authentication Panel */}
        <section className="lg:col-span-6 flex items-center justify-center">
          <div
            onPointerMove={handleGlassPointerMove}
            onPointerLeave={handleGlassPointerLeave}
            style={{
              transform: reduceMotion
                ? undefined
                : `perspective(1200px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
              transition: isDraggingCrop || tilt.rx !== 0 || tilt.ry !== 0
                ? 'transform 160ms cubic-bezier(0.16, 1, 0.3, 1)'
                : 'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            className="w-full max-w-xl obsidian-glass-card rounded-3xl border border-slate-200/90 dark:border-white/15 p-6 sm:p-8 space-y-6 overflow-hidden"
          >
            {/* Subtle specular top rim highlight */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/50 dark:via-white/40 to-transparent"
            />

            {/* Segmented Switcher */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-slate-100/90 dark:bg-[#070B14]/75 border border-slate-200/70 dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                }}
                className={`min-h-[44px] rounded-xl text-sm font-semibold transition-all whitespace-nowrap ${
                  mode === 'signin'
                    ? 'bg-white dark:bg-[#172238] text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t.tabSignIn}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                }}
                className={`min-h-[44px] rounded-xl text-sm font-semibold transition-all whitespace-nowrap ${
                  mode === 'signup'
                    ? 'bg-white dark:bg-[#172238] text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t.tabSignUp}
              </button>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-600 dark:text-rose-300"
              >
                {error}
              </div>
            )}

            {mode === 'signin' ? (
              <form onSubmit={handleSignIn} className="space-y-5">
                <div className="space-y-1">
                  <h1 className="font-display text-2xl font-bold tracking-tight">{t.signInTitle}</h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t.signInSubtitle}</p>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.identifierLabel}</span>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder={t.identifierPlaceholder}
                      autoComplete="username"
                      className="w-full min-h-[46px] ps-10 pe-4 py-3 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                    />
                  </div>
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.passwordLabel}</span>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type={showLoginPass ? 'text' : 'password'}
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder={t.passwordPlaceholder}
                      autoComplete="current-password"
                      className="w-full min-h-[46px] ps-10 pe-12 py-3 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPass((v) => !v)}
                      aria-label="Toggle password visibility"
                      className="absolute end-1 top-1/2 -translate-y-1/2 min-w-[40px] min-h-[40px] rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    >
                      {showLoginPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </label>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full min-h-[48px] rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/25 disabled:opacity-60"
                >
                  <span>{loading ? t.signingInBtn : t.signInBtn}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <div className="space-y-5">
                {/* Unboxed Step Indicator + Sleek Progress Rail (zero pills) */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono-tabular font-semibold text-indigo-600 dark:text-sky-400">
                        {t.stepWord} {formatNumber(signupStep, locale)} {t.stepOfWord} {formatNumber(2, locale)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        {signupStep === 1 ? t.stepCredentialsTitle : t.stepProfileTitle}
                      </span>
                    </div>

                    {signupStep === 2 && (
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setSignupStep(1);
                        }}
                        className="min-h-[36px] px-2.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>{t.backToCredentialsBtn}</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-1 rounded-full bg-indigo-600 dark:bg-indigo-500" />
                    <div
                      className={`h-1 rounded-full transition-colors duration-200 ${
                        signupStep === 2 ? 'bg-indigo-600 dark:bg-sky-400' : 'bg-slate-200 dark:bg-white/10'
                      }`}
                    />
                  </div>
                </div>

                <AnimatePresence mode="wait" initial={false}>
                  {signupStep === 1 ? (
                    <motion.form
                      key="signup-step-1"
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -10 }}
                      transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: [0.16, 1, 0.3, 1] }}
                      onSubmit={handleAdvanceToStep2}
                      className="space-y-4"
                    >
                      <div className="space-y-1">
                        <h1 className="font-display text-2xl font-bold tracking-tight">{t.signUpTitle}</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{t.signUpSubtitle}</p>
                      </div>

                      <label className="block space-y-1.5">
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.emailLabel}</span>
                        <div className="relative">
                          <Mail className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder={t.emailPlaceholder}
                            autoComplete="email"
                            className="w-full min-h-[46px] ps-10 pe-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                        </div>
                      </label>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.passwordLabel}</span>
                          {password.length > 0 && (
                            <span
                              className={`text-[11px] font-medium ${
                                passwordStrength === 1
                                  ? 'text-amber-500'
                                  : passwordStrength === 2
                                    ? 'text-sky-500'
                                    : 'text-emerald-500'
                              }`}
                            >
                              {passwordStrength === 1
                                ? t.passwordStrengthWeak
                                : passwordStrength === 2
                                  ? t.passwordStrengthGood
                                  : t.passwordStrengthStrong}
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <Lock className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type={showSignupPass ? 'text' : 'password'}
                            required
                            minLength={6}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t.passwordPlaceholder}
                            autoComplete="new-password"
                            className="w-full min-h-[46px] ps-10 pe-12 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                          <button
                            type="button"
                            onClick={() => setShowSignupPass((v) => !v)}
                            aria-label="Toggle password visibility"
                            className="absolute end-1 top-1/2 -translate-y-1/2 min-w-[40px] min-h-[40px] rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          >
                            {showSignupPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5 pt-1">
                          <div
                            className={`h-1 rounded-full ${
                              passwordStrength >= 1 ? (passwordStrength === 1 ? 'bg-amber-500' : 'bg-indigo-500') : 'bg-slate-200 dark:bg-white/10'
                            }`}
                          />
                          <div
                            className={`h-1 rounded-full ${
                              passwordStrength >= 2 ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-white/10'
                            }`}
                          />
                          <div
                            className={`h-1 rounded-full ${
                              passwordStrength >= 3 ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-white/10'
                            }`}
                          />
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.passwordMinHint}</p>
                      </div>

                      <label className="block space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {t.confirmPasswordLabel}
                          </span>
                          {confirmPassword.length > 0 && (
                            <span
                              className={`text-[11px] font-medium inline-flex items-center gap-1 ${
                                passwordsMatch ? 'text-emerald-500' : 'text-rose-500'
                              }`}
                            >
                              {passwordsMatch ? <Check className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                              {passwordsMatch ? t.passwordsMatchLabel : t.passwordsMismatch}
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <Lock className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type={showSignupPass ? 'text' : 'password'}
                            required
                            minLength={6}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder={t.confirmPasswordPlaceholder}
                            autoComplete="new-password"
                            className="w-full min-h-[46px] ps-10 pe-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                        </div>
                      </label>

                      <button
                        type="submit"
                        className="w-full min-h-[48px] rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/25"
                      >
                        <span>{t.continueProfileBtn}</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </motion.form>
                  ) : (
                    <motion.form
                      key="signup-step-2"
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
                      transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: [0.16, 1, 0.3, 1] }}
                      onSubmit={handleSignUp}
                      className="space-y-4"
                    >
                      {/* Drag-and-Drop Circular Avatar Ring with Live Crop Preview */}
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDraggingFile(true);
                        }}
                        onDragLeave={() => setIsDraggingFile(false)}
                        onDrop={handleDropAvatar}
                        className={`rounded-2xl border transition-colors p-4 flex flex-col sm:flex-row items-center gap-4 ${
                          isDraggingFile
                            ? 'border-indigo-500 bg-indigo-500/10'
                            : 'border-slate-200 dark:border-white/12 bg-white/60 dark:bg-[#070B14]/55'
                        }`}
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={handleSelectAvatar}
                        />

                        {avatarPreviewUrl ? (
                          <div
                            onPointerDown={handleCropPointerDown}
                            onPointerMove={handleCropPointerMove}
                            onPointerUp={handleCropPointerUp}
                            onPointerCancel={handleCropPointerUp}
                            style={{ width: CROP_RING_PX, height: CROP_RING_PX }}
                            className={`relative rounded-full overflow-hidden shrink-0 border-2 border-indigo-500/80 dark:border-sky-400/80 shadow-lg bg-[#070B14] touch-none ${
                              isDraggingCrop ? 'cursor-grabbing' : 'cursor-grab'
                            }`}
                          >
                            <img
                              src={avatarPreviewUrl}
                              alt="Avatar crop preview"
                              draggable={false}
                              style={{
                                transform: `translate(${cropOffset.x}px, ${cropOffset.y}px) scale(${cropZoom})`,
                              }}
                              className="w-full h-full object-cover select-none pointer-events-none"
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={{ width: CROP_RING_PX, height: CROP_RING_PX }}
                            aria-label={t.avatarChooseBtn}
                            className="rounded-full shrink-0 border-2 border-dashed border-indigo-400/70 dark:border-white/25 hover:border-indigo-500 dark:hover:border-sky-400 bg-indigo-500/5 dark:bg-white/5 flex flex-col items-center justify-center gap-1.5 transition-colors"
                          >
                            <UploadCloud className="w-6 h-6 text-indigo-500 dark:text-sky-400" />
                            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                              {t.avatarChooseBtn}
                            </span>
                          </button>
                        )}

                        <div className="flex-1 min-w-0 w-full space-y-2.5 text-center sm:text-start">
                          <div>
                            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{t.avatarPickLabel}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {avatarPreviewUrl ? t.avatarDragZoomHint : t.avatarDropHint}
                            </p>
                          </div>

                          {avatarPreviewUrl ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <ZoomIn className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                <input
                                  type="range"
                                  min={1}
                                  max={2.5}
                                  step={0.05}
                                  value={cropZoom}
                                  onChange={(e) => setCropZoom(Number(e.target.value))}
                                  aria-label="Zoom avatar"
                                  className="w-full accent-indigo-600 cursor-pointer"
                                />
                              </div>

                              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                                <button
                                  type="button"
                                  onClick={() => fileInputRef.current?.click()}
                                  className="min-h-[36px] px-3 rounded-lg bg-white dark:bg-[#172238] border border-slate-200 dark:border-white/12 text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-white/10 transition-colors"
                                >
                                  <Camera className="w-3.5 h-3.5 text-indigo-500" />
                                  <span>{t.avatarChangeBtn}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCropZoom(1.1);
                                    setCropOffset({ x: 0, y: 0 });
                                  }}
                                  className="min-h-[36px] px-2.5 rounded-lg border border-slate-200 dark:border-white/12 text-xs font-medium text-slate-600 dark:text-slate-300 inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  <span>{t.avatarResetBtn}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={handleRemoveAvatar}
                                  className="min-h-[36px] px-2.5 rounded-lg border border-rose-500/25 text-xs font-medium text-rose-600 dark:text-rose-400 inline-flex items-center gap-1 hover:bg-rose-500/10 transition-colors"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  <span>{t.avatarRemoveBtn}</span>
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="min-h-[38px] px-3.5 rounded-xl bg-white dark:bg-[#172238] border border-slate-200 dark:border-white/12 text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-white/10 transition-colors"
                            >
                              <Camera className="w-3.5 h-3.5 text-indigo-500" />
                              <span>{t.avatarChooseBtn}</span>
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid sm:grid-cols-2 gap-3.5">
                        <label className="block space-y-1">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.fullNameLabel}</span>
                          <div className="relative">
                            <User className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              required
                              minLength={2}
                              maxLength={60}
                              value={displayName}
                              onChange={(e) => setDisplayName(e.target.value)}
                              placeholder={t.fullNamePlaceholder}
                              className="w-full min-h-[44px] ps-10 pe-3 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </label>

                        <label className="block space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.usernameLabel}</span>
                            {usernameStatus === 'available' && (
                              <span className="text-[11px] font-semibold text-emerald-500 inline-flex items-center gap-1">
                                <Check className="w-3 h-3" /> {t.usernameAvailable}
                              </span>
                            )}
                            {usernameStatus === 'taken' && (
                              <span className="text-[11px] font-semibold text-rose-500 inline-flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> {t.usernameTaken}
                              </span>
                            )}
                            {usernameStatus === 'invalid' && (
                              <span className="text-[11px] text-amber-500">{t.usernameInvalid}</span>
                            )}
                          </div>
                          <div className="relative">
                            <AtSign className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              required
                              value={username}
                              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                              placeholder={t.usernamePlaceholder}
                              className="w-full min-h-[44px] ps-10 pe-3 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </label>
                      </div>

                      <label className="block space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.bioLabel}</span>
                          <span className="text-[11px] font-mono-tabular text-slate-400">
                            {formatNumber(bio.length, locale)}/{formatNumber(240, locale)}
                          </span>
                        </div>
                        <textarea
                          rows={2}
                          maxLength={240}
                          value={bio}
                          onChange={(e) => setBio(e.target.value)}
                          placeholder={t.bioPlaceholder}
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </label>

                      <div className="grid sm:grid-cols-2 gap-3.5">
                        <label className="block space-y-1">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.phoneLabel}</span>
                          <div className="relative">
                            <Phone className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="tel"
                              value={phone}
                              onChange={(e) => setPhone(e.target.value)}
                              placeholder={t.phonePlaceholder}
                              className="w-full min-h-[44px] ps-10 pe-3 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </label>

                        <label className="block space-y-1">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t.countryLabel}</span>
                          <div className="relative">
                            <MapPin className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              value={country}
                              onChange={(e) => setCountry(e.target.value)}
                              placeholder={t.countryPlaceholder}
                              className="w-full min-h-[44px] ps-10 pe-3 py-2.5 rounded-xl border border-slate-200 dark:border-white/12 bg-white/80 dark:bg-[#070B14]/70 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </label>
                      </div>

                      <button
                        type="submit"
                        disabled={loading || usernameStatus === 'taken' || usernameStatus === 'invalid'}
                        className="w-full min-h-[48px] rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/25 disabled:opacity-60"
                      >
                        <span>{loading ? t.signingUpBtn : t.signUpBtn}</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </motion.form>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { translations } from '../i18n/translations';
import type { Locale } from '../types/zephyrix';

interface SplashScreenProps {
  locale: Locale;
  reduceMotion?: boolean;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ locale, reduceMotion = false }) => {
  const t = translations[locale];
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <motion.div
      key="zephyrix-splash"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: reduceMotion ? 1 : 1.03 }}
      transition={{ duration: reduceMotion ? 0.12 : 0.32, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#F2F5FA] dark:bg-[#070B14] text-slate-900 dark:text-slate-100 select-none overflow-hidden"
    >
      {/* Ambient architectural depth glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 w-[540px] h-[540px] rounded-full bg-indigo-500/15 dark:bg-indigo-500/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 w-[420px] h-[420px] rounded-full bg-sky-500/10 dark:bg-sky-400/12 blur-3xl"
      />

      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0.15 : 0.52, ease: [0.16, 1, 0.3, 1] }}
        className="relative flex flex-col items-center gap-7 px-6 text-center"
      >
        {/* Obsidian Frosted 3D Emblem Shell */}
        <motion.div
          initial={reduceMotion ? false : { scale: 0.9, rotateX: 8 }}
          animate={{ scale: 1, rotateX: 0 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="obsidian-glass-card p-2.5 rounded-[30px] border border-slate-200/90 dark:border-white/15"
        >
          <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-[22px] overflow-hidden bg-[#0B101B] ring-1 ring-inset ring-white/15">
            {!imgFailed ? (
              <img
                src="/src/assets/images/zephyrix_splash_emblem_1795359941658.jpg"
                alt="Zephyrix"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-600 to-sky-500 text-white font-display text-4xl font-bold">
                Z
              </div>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.42, delay: reduceMotion ? 0 : 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-2 max-w-xs"
        >
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.brand}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{t.splashSubtitle}</p>
        </motion.div>

        <div className="w-48 h-1 rounded-full bg-slate-200/90 dark:bg-white/10 overflow-hidden">
          {reduceMotion ? (
            <div className="h-full w-2/3 rounded-full bg-indigo-500" />
          ) : (
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: '200%' }}
              transition={{ repeat: Infinity, duration: 1.05, ease: [0.4, 0, 0.2, 1] }}
              className="h-full w-1/2 rounded-full bg-gradient-to-r from-indigo-500 via-sky-400 to-indigo-500"
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

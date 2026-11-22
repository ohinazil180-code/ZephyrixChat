import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { translations } from '../i18n/translations';
import type { Locale } from '../types/zephyrix';

interface Props {
  locale: Locale;
  compact?: boolean;
}

export const PWAInstallButton: React.FC<Props> = ({ locale, compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIosGuide, setShowIosGuide] = useState(false);
  const t = translations[locale];

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        <Download className="w-4 h-4" />
        {!compact && <span>{t.installApp}</span>}
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIosGuide(true)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-white/15 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
        >
          <Smartphone className="w-4 h-4" />
          {!compact && <span>{t.installApp}</span>}
        </button>

        {showIosGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t.installIosTitle}</h3>
                <button
                  type="button"
                  onClick={() => setShowIosGuide(false)}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white min-h-[40px] min-w-[40px] flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
                <span className="block">{t.installIosStep1}</span>
                <span className="block">{t.installIosStep2}</span>
              </p>
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="mt-5 w-full rounded-xl bg-slate-900 dark:bg-indigo-600 py-2.5 text-sm font-medium text-white"
              >
                {t.close}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

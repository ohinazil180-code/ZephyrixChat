import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { translations } from '../i18n/translations';
import type { Locale } from '../types/zephyrix';

export const OfflineIndicator: React.FC<{ locale: Locale }> = ({ locale }) => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 md:bottom-5 inset-inline-start-4 z-50 flex items-center gap-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg border border-amber-400/40"
    >
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>{translations[locale].offlineBanner}</span>
    </div>
  );
};

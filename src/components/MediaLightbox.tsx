import React, { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { formatBytes } from '../i18n/translations';
import type { MessageAttachment } from '../types/zephyrix';

interface MediaLightboxProps {
  attachment: MessageAttachment | null;
  onClose: () => void;
}

export const MediaLightbox: React.FC<MediaLightboxProps> = ({ attachment, onClose }) => {
  useEffect(() => {
    if (!attachment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);

  if (!attachment) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between px-5 py-4 text-white border-b border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{attachment.originalName}</p>
          <p className="text-xs text-slate-400 font-mono-tabular">
            {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={attachment.url}
            download={attachment.originalName}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 hover:bg-white/20 px-3.5 py-2 text-xs font-medium min-h-[40px]"
          >
            <Download className="w-4 h-4" />
            <span>Download</span>
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close viewer"
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 flex items-center justify-center p-4 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {attachment.kind === 'video' ? (
          <video
            src={attachment.url}
            controls
            autoPlay
            className="max-h-[84vh] max-w-full rounded-2xl shadow-2xl border border-white/10"
          />
        ) : (
          <img
            src={attachment.url}
            alt={attachment.originalName}
            referrerPolicy="no-referrer"
            className="max-h-[84vh] max-w-full object-contain rounded-2xl shadow-2xl"
          />
        )}
      </div>
    </div>
  );
};

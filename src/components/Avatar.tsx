import React, { useState } from 'react';
import { Bookmark, Bot, Hash, Users } from 'lucide-react';

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  kind?: 'user' | 'group' | 'channel' | 'saved' | 'forge' | 'bot';
  online?: boolean;
}

const sizeMap = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-xl',
};

const palette = [
  'from-indigo-500 to-violet-600',
  'from-cyan-500 to-blue-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-600',
  'from-rose-500 to-pink-600',
];

function pickGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

export const Avatar: React.FC<AvatarProps> = ({
  name,
  src,
  size = 'md',
  kind = 'user',
  online = false,
}) => {
  const [imgError, setImgError] = useState(false);
  const initials = (name || 'Z')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');

  const showImg = Boolean(src) && !imgError && kind === 'user';

  return (
    <div className={`relative shrink-0 ${sizeMap[size]} rounded-2xl select-none`}>
      {showImg ? (
        <img
          src={src!}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="w-full h-full object-cover rounded-2xl border border-slate-200 dark:border-white/10"
        />
      ) : (
        <div
          className={`w-full h-full rounded-2xl flex items-center justify-center font-display font-semibold text-white bg-gradient-to-br ${
            kind === 'forge'
              ? 'from-cyan-500 to-indigo-600'
              : kind === 'saved'
                ? 'from-indigo-600 to-slate-700'
                : pickGradient(name || 'Zephyrix')
          } shadow-sm`}
        >
          {kind === 'saved' ? (
            <Bookmark className="w-5 h-5" />
          ) : kind === 'forge' || kind === 'bot' ? (
            <Bot className="w-5 h-5" />
          ) : kind === 'channel' ? (
            <Hash className="w-5 h-5" />
          ) : kind === 'group' ? (
            <Users className="w-5 h-5" />
          ) : (
            <span>{initials || 'Z'}</span>
          )}
        </div>
      )}

      {online && kind === 'user' && (
        <span
          aria-label="Online"
          className="absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-[#0F172A]"
        />
      )}
    </div>
  );
};

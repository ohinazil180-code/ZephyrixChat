import React from 'react';
import { Bot, Check, Code, Shield } from 'lucide-react';

interface BadgeProps {
  size?: 'sm' | 'md';
  className?: string;
}

export const VerifiedBadge: React.FC<BadgeProps> = ({ size = 'sm', className = '' }) => {
  const isSm = size === 'sm';
  return (
    <span
      title="Verified Account"
      className={`inline-flex items-center justify-center rounded-full bg-cyan-500 text-white shrink-0 shadow-sm shadow-cyan-500/20 select-none ${
        isSm ? 'w-3.5 h-3.5' : 'w-4 h-4'
      } ${className}`}
    >
      <Check className={isSm ? 'w-2.5 h-2.5 stroke-[3.5]' : 'w-3 h-3 stroke-[3.5]'} />
    </span>
  );
};

export const DeveloperBadge: React.FC<BadgeProps> = ({ size = 'sm', className = '' }) => {
  const isSm = size === 'sm';
  return (
    <span
      title="Verified Developer"
      className={`inline-flex items-center gap-1 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-500 dark:text-indigo-400 font-mono-tabular font-bold select-none shrink-0 ${
        isSm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      } ${className}`}
    >
      <Code className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      <span>DEV</span>
    </span>
  );
};

export const BotBadge: React.FC<{ isVerified?: boolean; size?: 'sm' | 'md'; className?: string }> = ({
  isVerified = true,
  size = 'sm',
  className = '',
}) => {
  const isSm = size === 'sm';
  return (
    <span className={`inline-flex items-center gap-1 select-none shrink-0 ${className}`}>
      <span
        title="Automated AI Bot"
        className={`inline-flex items-center gap-1 rounded-md bg-sky-500/15 border border-sky-500/30 text-sky-600 dark:text-sky-400 font-bold ${
          isSm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
        }`}
      >
        <Bot className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
        <span>BOT</span>
      </span>
      {isVerified && <VerifiedBadge size={size} />}
    </span>
  );
};

export const AdminBadge: React.FC<BadgeProps> = ({ size = 'sm', className = '' }) => {
  const isSm = size === 'sm';
  return (
    <span
      title="Super Administrator"
      className={`inline-flex items-center gap-1 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 font-bold select-none shrink-0 ${
        isSm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      } ${className}`}
    >
      <Shield className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      <span>ADMIN</span>
    </span>
  );
};

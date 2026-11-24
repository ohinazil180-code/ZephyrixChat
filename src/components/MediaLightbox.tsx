import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Loader2,
  WrapText,
  X,
} from 'lucide-react';
import { formatBytes } from '../i18n/translations';
import type { MessageAttachment } from '../types/zephyrix';

interface MediaLightboxProps {
  attachment: MessageAttachment | null;
  onClose: () => void;
}

type PreviewMode = 'image' | 'video' | 'pdf' | 'markdown' | 'json' | 'text' | 'unsupported';

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB cap

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function classifyPreviewMode(att: MessageAttachment): PreviewMode {
  const mime = (att.mimeType || '').toLowerCase();
  const ext = getFileExtension(att.originalName || '');

  if (att.kind === 'image' || mime.startsWith('image/')) return 'image';
  if (att.kind === 'video' || mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown' || ext === '.md' || ext === '.markdown') {
    return 'markdown';
  }
  if (mime === 'application/json' || ext === '.json') {
    return 'json';
  }
  if (
    mime.startsWith('text/') ||
    ['.txt', '.csv', '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.yml', '.yaml', '.xml'].includes(ext)
  ) {
    return 'text';
  }
  return 'unsupported';
}

function buildInlineUrl(url: string): string {
  if (!url) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}inline=1`;
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push(
        <strong key={`md-b-${keyIdx++}`} className="font-semibold text-white">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={`md-c-${keyIdx++}`}
          className="px-1.5 py-0.5 rounded bg-white/10 font-mono-tabular text-[12px] text-sky-300"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push(
        <em key={`md-i-${keyIdx++}`} className="italic text-slate-200">
          {raw.slice(1, -1)}
        </em>
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        if (isSafeHttpUrl(href)) {
          tokens.push(
            <a
              key={`md-a-${keyIdx++}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline underline-offset-2 hover:text-sky-300"
            >
              {label}
            </a>
          );
        } else {
          tokens.push(label);
        }
      } else {
        tokens.push(raw);
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

const SafeMarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <div key={`code-${i}`} className="rounded-xl border border-white/10 bg-[#070B14] overflow-hidden my-3">
          {lang && (
            <div className="px-3 py-1.5 border-b border-white/10 text-[11px] font-mono-tabular text-slate-400">
              {lang}
            </div>
          )}
          <pre className="p-3.5 text-xs font-mono-tabular text-slate-200 overflow-x-auto leading-relaxed">
            {codeLines.join('\n')}
          </pre>
        </div>
      );
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls =
        level === 1
          ? 'text-xl font-display font-bold text-white mt-4 mb-2 pb-1.5 border-b border-white/10'
          : level === 2
            ? 'text-lg font-display font-bold text-white mt-4 mb-2'
            : 'text-base font-display font-semibold text-slate-100 mt-3 mb-1.5';
      blocks.push(
        <div key={`h-${i}`} className={cls}>
          {renderInlineMarkdown(text)}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={`hr-${i}`} className="border-white/10 my-4" />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`q-${i}`}
          className="my-3 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/10 text-sm text-slate-300 italic"
        >
          {renderInlineMarkdown(quoteLines.join(' '))}
        </blockquote>
      );
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={`ul-${i}`} className="list-disc ps-5 space-y-1.5 my-2 text-sm text-slate-200">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`ol-${i}`} className="list-decimal ps-5 space-y-1.5 my-2 text-sm text-slate-200">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={`p-${i}`} className="text-sm text-slate-200 leading-relaxed my-2">
        {renderInlineMarkdown(line)}
      </p>
    );
    i++;
  }

  return <div className="space-y-1">{blocks}</div>;
};

export const MediaLightbox: React.FC<MediaLightboxProps> = ({ attachment, onClose }) => {
  const mode = useMemo<PreviewMode>(
    () => (attachment ? classifyPreviewMode(attachment) : 'unsupported'),
    [attachment]
  );

  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [rawView, setRawView] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!attachment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);

  useEffect(() => {
    setTextContent(null);
    setTextError(null);
    setRawView(false);
    setCopied(false);

    if (!attachment) return;
    if (mode !== 'text' && mode !== 'json' && mode !== 'markdown') return;

    if (attachment.sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
      setTextError('File exceeds the 2 MB inline preview limit. Download the file to view it locally.');
      return;
    }

    const controller = new AbortController();
    setLoadingText(true);
    fetch(buildInlineUrl(attachment.url), {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((txt) => {
        setTextContent(txt);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setTextError('Unable to load document preview. Please download the file instead.');
      })
      .finally(() => {
        setLoadingText(false);
      });

    return () => controller.abort();
  }, [attachment, mode]);

  if (!attachment) return null;

  const inlineUrl = buildInlineUrl(attachment.url);

  const jsonFormatted = (() => {
    if (mode !== 'json' || textContent === null) return { formatted: null, valid: true };
    try {
      return { formatted: JSON.stringify(JSON.parse(textContent), null, 2), valid: true };
    } catch {
      return { formatted: textContent, valid: false };
    }
  })();

  const handleCopyText = async () => {
    if (!textContent) return;
    const valueToCopy =
      mode === 'json' && !rawView && jsonFormatted.formatted ? jsonFormatted.formatted : textContent;
    try {
      await navigator.clipboard.writeText(valueToCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const renderFormatIcon = () => {
    if (mode === 'json') return <FileCode2 className="w-4 h-4 text-amber-400 shrink-0" />;
    if (mode === 'markdown') return <Code2 className="w-4 h-4 text-sky-400 shrink-0" />;
    if (attachment.mimeType === 'text/csv') return <FileSpreadsheet className="w-4 h-4 text-emerald-400 shrink-0" />;
    return <FileText className="w-4 h-4 text-indigo-400 shrink-0" />;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-md"
      onClick={onClose}
    >
      {/* Top Lightbox Header */}
      <div
        className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3.5 text-white border-b border-white/10 bg-[#0B101B]/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 min-w-0">
          {renderFormatIcon()}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{attachment.originalName}</p>
            <p className="text-xs text-slate-400 font-mono-tabular truncate">
              {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={attachment.url}
            download={attachment.originalName}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 hover:bg-white/20 px-3.5 py-2 text-xs font-medium min-h-[40px]"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Download</span>
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

      {/* Main Content Area */}
      <div
        className="flex-1 flex items-center justify-center p-4 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'video' && (
          <video
            src={attachment.url}
            controls
            autoPlay
            className="max-h-[84vh] max-w-full rounded-2xl shadow-2xl border border-white/10"
          />
        )}

        {mode === 'image' && (
          <img
            src={attachment.url}
            alt={attachment.originalName}
            referrerPolicy="no-referrer"
            className="max-h-[84vh] max-w-full object-contain rounded-2xl shadow-2xl"
          />
        )}

        {mode === 'pdf' && (
          <div className="w-full max-w-5xl h-[82vh] flex flex-col gap-2.5">
            <iframe
              src={inlineUrl}
              title={attachment.originalName}
              className="w-full flex-1 rounded-2xl border border-white/15 bg-white shadow-2xl"
            />
            <div className="flex items-center justify-between px-3 py-1.5 text-xs text-slate-400">
              <span>PDF rendered inline</span>
              <a
                href={inlineUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sky-400 hover:text-sky-300 font-medium"
              >
                <span>Open in new tab</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        )}

        {(mode === 'text' || mode === 'json' || mode === 'markdown') && (
          <div className="w-full max-w-4xl h-[82vh] flex flex-col rounded-2xl border border-white/15 bg-[#0F172A] shadow-2xl overflow-hidden text-slate-100">
            {/* Document Toolbar */}
            <div className="px-4 py-2.5 border-b border-white/10 bg-[#121A2B] flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-xs text-slate-400 font-mono-tabular">
                <span className="uppercase font-semibold text-slate-200">{mode}</span>
                {mode === 'json' && !jsonFormatted.valid && (
                  <span className="text-amber-400">· Raw fallback (invalid JSON)</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {(mode === 'json' || mode === 'markdown') && (
                  <div className="flex items-center p-0.5 rounded-lg bg-[#0B101B] border border-white/10 text-xs">
                    <button
                      type="button"
                      onClick={() => setRawView(false)}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                        !rawView ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Formatted
                    </button>
                    <button
                      type="button"
                      onClick={() => setRawView(true)}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                        rawView ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Raw
                    </button>
                  </div>
                )}

                {(mode === 'text' || rawView || mode === 'json') && (
                  <button
                    type="button"
                    onClick={() => setWordWrap((w) => !w)}
                    className={`min-h-[32px] px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                      wordWrap
                        ? 'bg-indigo-600/20 border-indigo-500/40 text-sky-300'
                        : 'border-white/10 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    <WrapText className="w-3.5 h-3.5" />
                    <span>Wrap</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={!textContent}
                  onClick={() => void handleCopyText()}
                  className="min-h-[32px] px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            {/* Document Body */}
            <div className="flex-1 overflow-auto slim-scroll p-5">
              {loadingText ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-400 text-xs">
                  <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                  <span>Loading preview...</span>
                </div>
              ) : textError ? (
                <div className="h-full flex flex-col items-center justify-center gap-4 text-center max-w-md mx-auto">
                  <FileText className="w-10 h-10 text-slate-500" />
                  <p className="text-sm text-slate-300">{textError}</p>
                  <a
                    href={attachment.url}
                    download={attachment.originalName}
                    className="min-h-[42px] px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download File</span>
                  </a>
                </div>
              ) : textContent !== null ? (
                mode === 'markdown' && !rawView ? (
                  <SafeMarkdownRenderer content={textContent} />
                ) : (
                  <div className="font-mono-tabular text-xs leading-relaxed text-slate-200">
                    {(mode === 'json' && !rawView && jsonFormatted.formatted
                      ? jsonFormatted.formatted
                      : textContent
                    )
                      .replace(/\r\n/g, '\n')
                      .split('\n')
                      .map((line, idx) => (
                        <div key={idx} className="flex gap-4 hover:bg-white/[0.03] px-2 rounded">
                          <span className="w-9 shrink-0 text-end select-none text-slate-500">{idx + 1}</span>
                          <span className={`flex-1 ${wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
                            {line || ' '}
                          </span>
                        </div>
                      ))}
                  </div>
                )
              ) : null}
            </div>
          </div>
        )}

        {mode === 'unsupported' && (
          <div className="w-full max-w-md rounded-3xl border border-white/15 bg-[#121A2B]/95 backdrop-blur-md p-8 text-center space-y-5 shadow-2xl text-white">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <FileText className="w-8 h-8" />
            </div>
            <div className="space-y-1.5">
              <h3 className="font-display text-base font-bold break-words">{attachment.originalName}</h3>
              <p className="text-xs text-slate-400 font-mono-tabular">
                {attachment.mimeType || 'application/octet-stream'} · {formatBytes(attachment.sizeBytes)}
              </p>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Inline preview is not available for this binary format. Download the file to open it on your device.
            </p>
            <a
              href={attachment.url}
              download={attachment.originalName}
              className="w-full min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
            >
              <Download className="w-4 h-4" />
              <span>Download File</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
};

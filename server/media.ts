import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request } from 'express';
import multer from 'multer';
import { requireAuth, type AuthRequest } from './auth.ts';
import { getDataDir } from './db.ts';
import { sendApiError } from './security.ts';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const EXT_TO_CANONICAL_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const INLINE_PREVIEWABLE_DOC_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
]);

const SAFE_FILENAME_RE = /^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/i;

export function getUploadsDir(): string {
  const configured = process.env.UPLOADS_DIR?.trim();
  const dir = configured ? path.resolve(configured) : path.join(getDataDir(), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function classifyMediaKind(mimeType: string, requestedKind?: string): 'image' | 'video' | 'voice' | 'document' {
  if (requestedKind === 'voice' && mimeType.startsWith('audio/')) return 'voice';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'voice';
  return 'document';
}

function resolveUploadMimeAndExt(rawMime: string, originalName: string): { mimeType: string; ext: string } | null {
  const originalExt = path.extname(originalName || '').toLowerCase();
  // Normalize browsers that report .md, .log, .csv, or .json as application/octet-stream
  if (
    (rawMime === 'application/octet-stream' || !rawMime) &&
    ['.md', '.txt', '.log', '.json', '.csv'].includes(originalExt)
  ) {
    return {
      mimeType: EXT_TO_CANONICAL_MIME[originalExt] || 'text/plain',
      ext: originalExt === '.log' ? '.txt' : originalExt,
    };
  }

  const mappedExt = ALLOWED_MIME_EXTENSIONS[rawMime];
  if (!mappedExt) return null;
  const canonicalMime = rawMime === 'text/x-markdown' ? 'text/markdown' : rawMime;
  return { mimeType: canonicalMime, ext: mappedExt };
}

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

export function registerMediaRoutes(app: Express): void {
  const uploadsRoot = getUploadsDir();

  app.post('/api/v1/media/upload', requireAuth, (req: AuthRequest, res) => {
    uploadMiddleware.single('file')(req as Request, res, (multerErr) => {
      if (multerErr) {
        if (multerErr instanceof multer.MulterError && multerErr.code === 'LIMIT_FILE_SIZE') {
          sendApiError(res, 413, 'FILE_TOO_LARGE', 'Maximum allowed file size is 25 MB.');
          return;
        }
        sendApiError(res, 400, 'UPLOAD_PARSE_ERROR', multerErr.message || 'Unable to parse uploaded file.');
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file || !file.buffer || file.size === 0) {
        sendApiError(res, 400, 'MISSING_FILE', 'No file was provided in upload request.');
        return;
      }

      const rawMime = (file.mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const resolved = resolveUploadMimeAndExt(rawMime, file.originalname || 'file');
      if (!resolved) {
        sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', `File type "${rawMime}" is not supported.`);
        return;
      }

      try {
        const { mimeType, ext } = resolved;
        const safeName = `${crypto.randomUUID()}${ext}`;
        const destPath = path.resolve(uploadsRoot, safeName);
        if (!destPath.startsWith(uploadsRoot + path.sep)) {
          sendApiError(res, 400, 'INVALID_PATH', 'Invalid storage path.');
          return;
        }

        fs.writeFileSync(destPath, file.buffer);
        const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const durationRaw = Number((req.body as { durationMs?: string | number })?.durationMs || 0);
        const durationMs = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.min(durationRaw, 3_600_000) : 0;
        const requestedKind = (req.body as { kind?: string })?.kind;
        const kind = classifyMediaKind(mimeType, requestedKind);
        const url = `/api/v1/media/file/${safeName}`;

        res.status(201).json({
          attachment: {
            storageKey: safeName,
            url,
            originalName: path.basename(file.originalname || `file${ext}`).slice(0, 180),
            mimeType,
            kind,
            sizeBytes: file.size,
            durationMs,
            checksum,
          },
        });
      } catch (err) {
        console.error('[media] Failed to store upload:', err instanceof Error ? err.message : 'unknown');
        sendApiError(res, 500, 'MEDIA_STORE_FAILED', 'Failed to save uploaded file on server.');
      }
    });
  });

  app.get('/api/v1/media/file/:filename', (req, res) => {
    const filename = String(req.params.filename || '').trim();
    if (!SAFE_FILENAME_RE.test(filename)) {
      sendApiError(res, 400, 'INVALID_FILENAME', 'Invalid media filename.');
      return;
    }

    const resolvedPath = path.resolve(uploadsRoot, filename);
    if (!resolvedPath.startsWith(uploadsRoot + path.sep)) {
      sendApiError(res, 403, 'FORBIDDEN_PATH', 'Access denied.');
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      sendApiError(res, 404, 'MEDIA_NOT_FOUND', 'Media file not found.');
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    const matchedMime = EXT_TO_CANONICAL_MIME[ext] || 'application/octet-stream';
    const wantsInline = req.query.inline === '1' || req.query.inline === 'true';

    res.setHeader('Content-Type', matchedMime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const isMediaStream =
      matchedMime.startsWith('image/') ||
      matchedMime.startsWith('video/') ||
      matchedMime.startsWith('audio/');

    if (!isMediaStream) {
      if (wantsInline && INLINE_PREVIEWABLE_DOC_MIMES.has(matchedMime)) {
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        if (matchedMime !== 'application/pdf') {
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        }
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }
    }

    res.sendFile(resolvedPath);
  });
}

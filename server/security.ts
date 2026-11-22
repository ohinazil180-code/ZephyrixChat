import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const EPHEMERAL_SESSION_PEPPER = crypto.randomBytes(32);

function getSessionPepper(): Buffer {
  const envVal = process.env.SESSION_PEPPER || process.env.SESSION_SECRET;
  if (envVal && envVal.length >= 16) {
    return crypto.createHash('sha256').update(envVal).digest();
  }
  return EPHEMERAL_SESSION_PEPPER;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function hashToken(token: string): string {
  return crypto.createHmac('sha256', getSessionPepper()).update(token).digest('hex');
}

export function hashIp(ip: string): string {
  return crypto.createHmac('sha256', getSessionPepper()).update(`ip:${ip}`).digest('hex').slice(0, 24);
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

// In-memory sliding-window rate limiter (zero external Redis required)
const memoryBuckets = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (memoryBuckets.get(key) || []).filter((ts) => ts > cutoff);
  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    memoryBuckets.set(key, timestamps);
    return { allowed: false, retryAfterSec };
  }
  timestamps.push(now);
  memoryBuckets.set(key, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const rawList = [
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    ...(process.env.CORS_ORIGIN || '').split(','),
  ];
  for (const raw of rawList) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // ignore invalid URLs
    }
  }
  return origins;
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = getAllowedOrigins();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
    let isSameHost = false;
    try {
      isSameHost = Boolean(host && new URL(origin).host === host);
    } catch {
      isSameHost = false;
    }

    if (isSameHost || allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With, X-Request-Id'
      );
    }
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

export function verifyCsrfForMutations(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(req.method)) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    next();
    return;
  }
  const customHeader = req.headers['x-requested-with'];
  if (customHeader === 'XMLHttpRequest') {
    next();
    return;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if ((host && parsedOrigin.host === host) || getAllowedOrigins().has(parsedOrigin.origin)) {
        next();
        return;
      }
    } catch {
      // fall through
    }
  }
  res.status(403).json({
    error: {
      code: 'CSRF_VALIDATION_FAILED',
      message: 'Missing required CSRF protection header or matching origin.',
      requestId: res.locals.requestId,
    },
  });
}

export function sendApiError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: res.locals.requestId || 'unknown',
    },
  });
}

export function isValidSafeUrl(raw: string): boolean {
  if (raw.startsWith('/api/v1/media/')) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

import type { MessageAttachment, OfflineDraftItem, SystemConfig } from '../types/zephyrix';

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || '').trim().replace(/\/$/, '');

export function apiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${API_BASE}${path}`;
}

let inMemoryToken: string | null = null;

export function setInMemoryToken(token: string | null): void {
  inMemoryToken = token;
}

export function getInMemoryToken(): string | null {
  return inMemoryToken;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (inMemoryToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }
  if (!(init.body instanceof FormData) && !headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const resp = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  });

  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }

  if (!resp.ok) {
    const errObj = (data?.error as { code?: string; message?: string }) || {};
    throw new ApiError(resp.status, errObj.code || 'REQUEST_FAILED', errObj.message || 'Request failed');
  }
  return data as T;
}

export async function fetchSystemConfig(): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/v1/auth/config');
}

export async function compressImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 350 * 1024) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.84));
    if (!blob || blob.size >= file.size) return file;
    const nextName = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], nextName, { type: 'image/webp' });
  } catch {
    return file;
  }
}

export async function uploadMediaFile(
  file: File,
  options: { durationMs?: number; kind?: 'voice' } = {}
): Promise<MessageAttachment> {
  const processed = await compressImageIfNeeded(file);
  const form = new FormData();
  form.append('file', processed, processed.name || 'upload.bin');
  if (options.durationMs) {
    form.append('durationMs', String(options.durationMs));
  }
  if (options.kind) {
    form.append('kind', options.kind);
  }

  const res = await apiFetch<{ attachment: MessageAttachment }>('/api/v1/media/upload', {
    method: 'POST',
    body: form,
  });

  return {
    ...res.attachment,
    url: apiUrl(res.attachment.url),
  };
}

// Offline outbox queue (unsent message drafts only, never credentials)
const OUTBOX_KEY = 'zephyrix_offline_outbox_v2';

export function getOfflineOutbox(): OfflineDraftItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OfflineDraftItem[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineMessage(item: OfflineDraftItem): void {
  const list = getOfflineOutbox();
  list.push(item);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
}

export function removeOfflineMessage(clientId: string): void {
  const list = getOfflineOutbox().filter((i) => i.clientId !== clientId);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
}

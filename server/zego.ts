import crypto from 'node:crypto';

export function getZegoCredentials(): { appId: number; serverSecret: string } | null {
  const appIdRaw = (process.env.ZEGO_APP_ID || '').trim();
  const serverSecret = (process.env.ZEGO_SERVER_SECRET || '').trim();
  const appId = Number(appIdRaw);
  if (!appIdRaw || !Number.isInteger(appId) || appId <= 0 || serverSecret.length !== 32) {
    return null;
  }
  return { appId, serverSecret };
}

export function isZegoConfigured(): boolean {
  return getZegoCredentials() !== null;
}

/**
 * Generates an official ZEGOCLOUD Token04 authentication token.
 * ZEGO_SERVER_SECRET stays strictly on the backend and is never sent to clients.
 */
export function generateToken04(
  appId: number,
  userId: string,
  serverSecret: string,
  effectiveTimeInSeconds = 3600,
  payload = ''
): string {
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('INVALID_ZEGO_APP_ID');
  }
  if (!userId || typeof userId !== 'string' || userId.length > 64) {
    throw new Error('INVALID_ZEGO_USER_ID');
  }
  if (typeof serverSecret !== 'string' || serverSecret.length !== 32) {
    throw new Error('INVALID_ZEGO_SERVER_SECRET');
  }
  if (!Number.isInteger(effectiveTimeInSeconds) || effectiveTimeInSeconds <= 0) {
    throw new Error('INVALID_ZEGO_TTL');
  }

  const createTime = Math.floor(Date.now() / 1000);
  const tokenInfo = {
    app_id: appId,
    user_id: userId,
    nonce: crypto.randomInt(-2147483648, 2147483647),
    ctime: createTime,
    expire: createTime + effectiveTimeInSeconds,
    payload,
  };

  const plaintext = JSON.stringify(tokenInfo);
  const iv = crypto.randomBytes(16).toString('hex').slice(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(serverSecret, 'utf8'), Buffer.from(iv, 'utf8'));
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const b1 = Buffer.alloc(8);
  b1.writeBigInt64BE(BigInt(tokenInfo.expire), 0);

  const ivBuf = Buffer.from(iv, 'utf8');
  const b2 = Buffer.alloc(2);
  b2.writeUInt16BE(ivBuf.byteLength, 0);

  const b3 = Buffer.alloc(2);
  b3.writeUInt16BE(encrypted.byteLength, 0);

  const combined = Buffer.concat([b1, b2, ivBuf, b3, encrypted]);
  return `04${combined.toString('base64')}`;
}

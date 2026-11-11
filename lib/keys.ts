import { createHash, randomBytes } from 'node:crypto';

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateApiKey(): string {
  return `htk_live_${randomBytes(24).toString('base64url')}`;
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, 13);
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

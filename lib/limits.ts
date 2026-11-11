import { hitLimit } from './rate-limit';
import { HttpError } from './http';

export async function enforceLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await hitLimit(key, limit, windowSeconds);
  if (result.ok) return;
  throw new HttpError(429, 'rate_limited', `Quá nhiều yêu cầu. Thử lại sau ${result.retryAfter} giây.`, {
    'retry-after': String(result.retryAfter),
  });
}

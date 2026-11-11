import { getDb } from './db';

export type LimitResult = {
  ok: boolean;
  remaining: number;
  retryAfter: number;
};

export async function hitLimit(key: string, limit: number, windowSeconds: number): Promise<LimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000));
  const db = await getDb();
  const result = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1,$2,1)
     on conflict (key) do update set
       count = case when rate_limits.window_start = excluded.window_start then rate_limits.count + 1 else 1 end,
       window_start = excluded.window_start
     returning count`,
    [key, windowStart],
  );
  const count = Number(result.rows[0]?.count ?? 1);
  const retryAfter = Math.max(1, Math.ceil(((windowStart + 1) * windowSeconds * 1000 - now) / 1000));
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfter };
}

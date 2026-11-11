import { randomUUID } from 'node:crypto';
import { getDb, saveState } from './db';
import {
  checkUpstreamUrl,
  droppedLogCount,
  forgetApiKey,
  forgetEndpoint,
  pendingQuotaUsage,
} from './gateway';
import { HttpError } from './http';
import { generateApiKey, hashApiKey, keyPrefix } from './keys';
import { periodOf } from './tokens';

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  capacity: number;
  refillPerSec: number;
  quotaMonthly: number;
  usedThisMonth: number;
  period: string;
  quotaRemaining: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type EndpointSummary = {
  id: string;
  slug: string;
  name: string;
  upstreamUrl: string;
  timeoutMs: number;
  enabled: boolean;
  createdAt: string;
};

export type GatewayLogView = {
  id: string;
  method: string;
  path: string;
  status: number;
  upstreamStatus: number | null;
  latencyMs: number;
  bucketRemaining: number | null;
  endpointSlug: string;
  upstream: string;
  error: string | null;
  createdAt: string;
};

export type Metrics = {
  requests1m: number;
  rps1m: number;
  errors1m: number;
  errorRate1m: number;
  requests15m: number;
  errors15m: number;
  rateLimited15m: number;
  droppedLogs: number;
  p50: number | null;
  p95: number | null;
  series: { minute: string; total: number; errors: number }[];
  topEndpoints: { slug: string; name: string; total: number; errors: number }[];
  recent: GatewayLogView[];
};

type RawLog = {
  status: number;
  latency_ms: number;
  created_at: string;
  endpoint_slug: string;
};

function quotaView(row: Record<string, unknown>): { used: number; remaining: number } {
  const pending = pendingQuotaUsage(String(row.id));
  const period = periodOf();
  const dbUsed = Number(row.used_this_month);
  const used =
    pending && pending.period === period
      ? Math.max(dbUsed, pending.used)
      : String(row.period) === period
        ? dbUsed
        : 0;
  return { used, remaining: Math.max(0, Number(row.quota_monthly) - used) };
}

export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const db = await getDb();
  const result = await db.query<Record<string, unknown>>(
    `select id, name, key_prefix, capacity, refill_per_sec, quota_monthly, used_this_month,
            period, revoked_at, last_used_at, created_at
     from api_keys where user_id = $1 order by created_at desc`,
    [userId],
  );
  return result.rows.map((row) => {
    const quota = quotaView(row);
    return {
      id: String(row.id),
      name: String(row.name),
      keyPrefix: String(row.key_prefix),
      capacity: Number(row.capacity),
      refillPerSec: Number(row.refill_per_sec),
      quotaMonthly: Number(row.quota_monthly),
      usedThisMonth: quota.used,
      period: String(row.period),
      quotaRemaining: quota.remaining,
      revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
      lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  });
}

export async function createApiKey(
  userId: string,
  input: { name: string; capacity: number; refillPerSec: number; quotaMonthly: number },
): Promise<{ key: ApiKeySummary; secret: string }> {
  const secret = generateApiKey();
  const id = `key-${randomUUID().slice(0, 8)}`;
  const db = await getDb();
  await db.query(
    `insert into api_keys (
       id, user_id, name, key_prefix, key_hash, capacity, refill_per_sec, quota_monthly,
       used_this_month, period
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)`,
    [
      id,
      userId,
      input.name,
      keyPrefix(secret),
      hashApiKey(secret),
      input.capacity,
      input.refillPerSec,
      input.quotaMonthly,
      periodOf(),
    ],
  );
  await saveState();
  const keys = await listApiKeys(userId);
  const key = keys.find((item) => item.id === id);
  if (!key) throw new HttpError(500, 'key_missing', 'Không tạo được API key.');
  return { key, secret };
}

export async function revokeApiKey(userId: string, keyId: string): Promise<ApiKeySummary> {
  const db = await getDb();
  const existing = await db.query<{ id: string; key_hash: string; revoked_at: string | null }>(
    'select id, key_hash, revoked_at from api_keys where id = $1 and user_id = $2',
    [keyId, userId],
  );
  const row = existing.rows[0];
  if (!row) throw new HttpError(404, 'key_not_found', 'Không tìm thấy API key.');
  if (!row.revoked_at) {
    await db.query('update api_keys set revoked_at = now() where id = $1', [keyId]);
    forgetApiKey(row.key_hash);
    await saveState();
  }
  const keys = await listApiKeys(userId);
  const key = keys.find((item) => item.id === keyId);
  if (!key) throw new HttpError(404, 'key_not_found', 'Không tìm thấy API key.');
  return key;
}

export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function assertUpstream(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('sandbox://')) {
    const kind = value.slice('sandbox://'.length).replace(/\/+$/, '');
    if (!['echo', 'slow', 'fail'].includes(kind)) {
      throw new HttpError(400, 'invalid_upstream', 'Sandbox hợp lệ: sandbox://echo, sandbox://slow, sandbox://fail.');
    }
    return `sandbox://${kind}`;
  }
  const check = checkUpstreamUrl(value);
  if (!check.ok) throw new HttpError(400, 'invalid_upstream', check.reason);
  return check.url.toString();
}

export async function listEndpoints(userId: string): Promise<EndpointSummary[]> {
  const db = await getDb();
  const result = await db.query<Record<string, unknown>>(
    `select id, slug, name, upstream_url, timeout_ms, enabled, created_at
     from endpoints where user_id = $1 order by created_at asc`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    upstreamUrl: String(row.upstream_url),
    timeoutMs: Number(row.timeout_ms),
    enabled: Boolean(row.enabled),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

export async function createEndpoint(
  userId: string,
  input: { slug: string; name: string; upstreamUrl: string; timeoutMs: number },
): Promise<EndpointSummary> {
  const slug = normalizeSlug(input.slug);
  if (slug.length < 2) throw new HttpError(400, 'invalid_slug', 'Slug cần ít nhất 2 ký tự a-z, 0-9, dấu gạch.');
  const upstreamUrl = assertUpstream(input.upstreamUrl);
  const db = await getDb();
  const clash = await db.query<{ n: number }>('select count(*)::int as n from endpoints where slug = $1', [slug]);
  if (Number(clash.rows[0]?.n ?? 0) > 0) {
    throw new HttpError(409, 'slug_taken', `Slug "${slug}" đã được dùng.`);
  }
  const id = `ep-${randomUUID().slice(0, 8)}`;
  await db.query(
    `insert into endpoints (id, user_id, slug, name, upstream_url, timeout_ms, enabled)
     values ($1,$2,$3,$4,$5,$6,true)`,
    [id, userId, slug, input.name, upstreamUrl, input.timeoutMs],
  );
  forgetEndpoint(slug);
  await saveState();
  const endpoints = await listEndpoints(userId);
  const endpoint = endpoints.find((item) => item.id === id);
  if (!endpoint) throw new HttpError(500, 'endpoint_missing', 'Không tạo được endpoint.');
  return endpoint;
}

export async function updateEndpoint(
  userId: string,
  endpointId: string,
  patch: { enabled?: boolean; upstreamUrl?: string; timeoutMs?: number; name?: string },
): Promise<EndpointSummary> {
  const db = await getDb();
  const existing = await db.query<Record<string, unknown>>(
    'select id, slug, name, upstream_url, timeout_ms, enabled from endpoints where id = $1 and user_id = $2',
    [endpointId, userId],
  );
  const row = existing.rows[0];
  if (!row) throw new HttpError(404, 'endpoint_not_found', 'Không tìm thấy endpoint.');
  const upstreamUrl = patch.upstreamUrl ? assertUpstream(patch.upstreamUrl) : String(row.upstream_url);
  const name = patch.name?.trim() || String(row.name);
  const timeoutMs = patch.timeoutMs ?? Number(row.timeout_ms);
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : Boolean(row.enabled);
  await db.query(
    'update endpoints set name = $2, upstream_url = $3, timeout_ms = $4, enabled = $5 where id = $1',
    [endpointId, name, upstreamUrl, timeoutMs, enabled],
  );
  forgetEndpoint(String(row.slug));
  await saveState();
  const endpoints = await listEndpoints(userId);
  const endpoint = endpoints.find((item) => item.id === endpointId);
  if (!endpoint) throw new HttpError(404, 'endpoint_not_found', 'Không tìm thấy endpoint.');
  return endpoint;
}

export async function deleteEndpoint(userId: string, endpointId: string): Promise<void> {
  const db = await getDb();
  const existing = await db.query<{ slug: string }>(
    'select slug from endpoints where id = $1 and user_id = $2',
    [endpointId, userId],
  );
  const row = existing.rows[0];
  if (!row) throw new HttpError(404, 'endpoint_not_found', 'Không tìm thấy endpoint.');
  await db.query('delete from endpoints where id = $1', [endpointId]);
  forgetEndpoint(row.slug);
  await saveState();
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export async function getMetrics(userId: string): Promise<Metrics> {
  const db = await getDb();
  const logs = await db.query<RawLog>(
    `select status, latency_ms, created_at, endpoint_slug
     from gateway_logs
     where user_id = $1 and created_at > now() - interval '15 minutes'
     order by created_at desc
     limit 20000`,
    [userId],
  );
  const endpoints = await listEndpoints(userId);
  const nameBySlug = new Map(endpoints.map((endpoint) => [endpoint.slug, endpoint.name]));

  const now = Date.now();
  const rows = logs.rows.map((row) => ({
    status: Number(row.status),
    latency: Number(row.latency_ms),
    at: new Date(row.created_at).getTime(),
    slug: row.endpoint_slug,
  }));

  const lastMinute = rows.filter((row) => now - row.at <= 60_000);
  const requests1m = lastMinute.length;
  const errors1m = lastMinute.filter((row) => row.status >= 500).length;
  const errors15m = rows.filter((row) => row.status >= 500).length;
  const rateLimited15m = rows.filter((row) => row.status === 429).length;

  const series: Metrics['series'] = [];
  for (let i = 14; i >= 0; i -= 1) {
    const start = now - (i + 1) * 60_000;
    const end = now - i * 60_000;
    const bucket = rows.filter((row) => row.at > start && row.at <= end);
    series.push({
      minute: new Date(end).toISOString().slice(11, 16),
      total: bucket.length,
      errors: bucket.filter((row) => row.status >= 500).length,
    });
  }

  const bySlug = new Map<string, { total: number; errors: number }>();
  for (const row of rows) {
    const entry = bySlug.get(row.slug) ?? { total: 0, errors: 0 };
    entry.total += 1;
    if (row.status >= 500) entry.errors += 1;
    bySlug.set(row.slug, entry);
  }
  const topEndpoints = [...bySlug.entries()]
    .map(([slug, value]) => ({
      slug,
      name: nameBySlug.get(slug) ?? slug,
      total: value.total,
      errors: value.errors,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const recent = await listRecentLogs(userId, 20);

  return {
    requests1m,
    rps1m: Math.round((requests1m / 60) * 100) / 100,
    errors1m,
    errorRate1m: requests1m === 0 ? 0 : Math.round((errors1m / requests1m) * 10_000) / 10_000,
    requests15m: rows.length,
    errors15m,
    rateLimited15m,
    droppedLogs: droppedLogCount(),
    p50: percentile(rows.map((row) => row.latency), 0.5),
    p95: percentile(rows.map((row) => row.latency), 0.95),
    series,
    topEndpoints,
    recent,
  };
}

export async function listRecentLogs(userId: string, limit = 20): Promise<GatewayLogView[]> {
  const db = await getDb();
  const result = await db.query<Record<string, unknown>>(
    `select id, method, path, status, upstream_status, latency_ms, bucket_remaining,
            endpoint_slug, upstream, error, created_at
     from gateway_logs where user_id = $1 order by created_at desc limit $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    method: String(row.method),
    path: String(row.path),
    status: Number(row.status),
    upstreamStatus: row.upstream_status === null ? null : Number(row.upstream_status),
    latencyMs: Number(row.latency_ms),
    bucketRemaining: row.bucket_remaining === null ? null : Number(row.bucket_remaining),
    endpointSlug: String(row.endpoint_slug),
    upstream: String(row.upstream),
    error: row.error ? String(row.error) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

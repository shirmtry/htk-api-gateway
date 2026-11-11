import { randomUUID } from 'node:crypto';
import { getDb, saveState, usingBlob } from './db';
import { clientIp, logEvent } from './http';
import { hashApiKey, parseBearer } from './keys';
import {
  consumeQuota,
  createBucket,
  createQuota,
  periodOf,
  takeToken,
  type BucketConfig,
  type BucketState,
  type QuotaState,
} from './tokens';

export type ApiKeyRecord = {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  capacity: number;
  refillPerSec: number;
  quotaMonthly: number;
  usedThisMonth: number;
  period: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type EndpointRecord = {
  id: string;
  userId: string;
  slug: string;
  name: string;
  upstreamUrl: string;
  timeoutMs: number;
  enabled: boolean;
};

export type GatewayLogInput = {
  userId: string;
  keyId: string;
  endpointId: string;
  endpointSlug: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  upstreamStatus: number | null;
  latencyMs: number;
  bucketRemaining: number | null;
  upstream: string;
  error: string | null;
};

type QueuedLog = GatewayLogInput & { id: string; createdAt: string };

type CacheEntry<T> = { value: T; expiresAt: number };
type QuotaDelta = { period: string; delta: number };

type Globals = typeof globalThis & {
  __htkKeyCache?: Map<string, CacheEntry<ApiKeyRecord | null>>;
  __htkEndpointCache?: Map<string, CacheEntry<EndpointRecord | null>>;
  __htkBuckets?: Map<string, BucketState>;
  __htkQuotaState?: Map<string, QuotaState>;
  __htkQuotaDelta?: Map<string, QuotaDelta>;
  __htkLogs?: QueuedLog[];
  __htkFlushChain?: Promise<void>;
  __htkLastFlushAt?: number;
  __htkLastPersistAt?: number;
  __htkFlushCount?: number;
  __htkDroppedLogs?: number;
};

const globals = globalThis as Globals;
const KEY_TTL_MS = 3000;
const MAX_REQUEST_BYTES = 128 * 1024;
const LOG_BATCH = 500;
const MAX_PENDING_LOGS = 8000;
const KEEP_LOGS_PER_USER = 3000;
const MAX_BATCHES_PER_FLUSH = 20;

export type UpstreamCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Live upstreams must be public HTTPS origins. This blocks the obvious SSRF
 * targets; DNS rebinding is still a deployment-level concern.
 */
export function checkUpstreamUrl(raw: string): UpstreamCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL không hợp lệ.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Live upstream phải dùng HTTPS.' };
  if (url.username || url.password) return { ok: false, reason: 'URL không được chứa thông tin đăng nhập.' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'URL thiếu host.' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'Host nội bộ bị chặn.' };
  }
  if (host === '0.0.0.0' || host === '::' || host === '::1') {
    return { ok: false, reason: 'Host nội bộ bị chặn.' };
  }
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
    return { ok: false, reason: 'Dải IP nội bộ bị chặn.' };
  }
  if (host.startsWith('172.')) {
    const second = Number(host.split('.')[1]);
    if (second >= 16 && second <= 31) return { ok: false, reason: 'Dải IP nội bộ bị chặn.' };
  }
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    return { ok: false, reason: 'Dải IPv6 nội bộ bị chặn.' };
  }
  return { ok: true, url };
}

function mapKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    keyHash: String(row.key_hash),
    capacity: Number(row.capacity),
    refillPerSec: Number(row.refill_per_sec),
    quotaMonthly: Number(row.quota_monthly),
    usedThisMonth: Number(row.used_this_month),
    period: String(row.period),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
  };
}

function mapEndpoint(row: Record<string, unknown>): EndpointRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.slug),
    name: String(row.name),
    upstreamUrl: String(row.upstream_url),
    timeoutMs: Number(row.timeout_ms),
    enabled: Boolean(row.enabled),
  };
}

export async function resolveApiKey(secret: string): Promise<ApiKeyRecord | null> {
  const hash = hashApiKey(secret);
  const cache = (globals.__htkKeyCache ??= new Map());
  const now = Date.now();
  const hit = cache.get(hash);
  if (hit && hit.expiresAt > now) return hit.value;

  const db = await getDb();
  const result = await db.query<Record<string, unknown>>(
    `select id, user_id, name, key_prefix, key_hash, capacity, refill_per_sec, quota_monthly,
            used_this_month, period, revoked_at, last_used_at
     from api_keys where key_hash = $1`,
    [hash],
  );
  const value = result.rows[0] ? mapKey(result.rows[0]) : null;
  cache.set(hash, { value, expiresAt: now + KEY_TTL_MS });
  return value;
}

export function forgetApiKey(hash: string): void {
  globals.__htkKeyCache?.delete(hash);
}

export async function resolveEndpoint(slug: string): Promise<EndpointRecord | null> {
  const cache = (globals.__htkEndpointCache ??= new Map());
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expiresAt > now) return hit.value;

  const db = await getDb();
  const result = await db.query<Record<string, unknown>>(
    'select id, user_id, slug, name, upstream_url, timeout_ms, enabled from endpoints where slug = $1',
    [slug],
  );
  const value = result.rows[0] ? mapEndpoint(result.rows[0]) : null;
  cache.set(slug, { value, expiresAt: now + KEY_TTL_MS });
  return value;
}

export function forgetEndpoint(slug: string): void {
  globals.__htkEndpointCache?.delete(slug);
}

function consumeBucket(
  key: ApiKeyRecord,
  endpoint: EndpointRecord,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const buckets = (globals.__htkBuckets ??= new Map());
  const id = `${key.id}:${endpoint.id}`;
  const config: BucketConfig = { capacity: key.capacity, refillPerSec: key.refillPerSec };
  const state = buckets.get(id) ?? createBucket(config);
  const result = takeToken(state, config);
  buckets.set(id, result.next);
  return { allowed: result.allowed, remaining: result.remaining, retryAfterMs: result.retryAfterMs };
}

function consumeQuotaFor(key: ApiKeyRecord): { allowed: boolean; remaining: number; period: string } {
  const states = (globals.__htkQuotaState ??= new Map());
  const state = states.get(key.id) ?? createQuota(key.period, key.usedThisMonth);
  const result = consumeQuota(state, key.quotaMonthly);
  states.set(key.id, result.state);
  if (result.allowed) {
    const deltas = (globals.__htkQuotaDelta ??= new Map());
    const composite = `${key.id}|${result.state.period}`;
    const existing = deltas.get(composite);
    deltas.set(composite, { period: result.state.period, delta: (existing?.delta ?? 0) + 1 });
  }
  return { allowed: result.allowed, remaining: result.remaining, period: result.state.period };
}

export function droppedLogCount(): number {
  return globals.__htkDroppedLogs ?? 0;
}

export function pendingQuotaUsage(keyId: string): { used: number; period: string } | null {
  const state = globals.__htkQuotaState?.get(keyId);
  return state ? { used: state.used, period: state.period } : null;
}

function queueGatewayLog(input: GatewayLogInput): void {
  const queue = (globals.__htkLogs ??= []);
  queue.push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
  if (queue.length > MAX_PENDING_LOGS) {
    const dropped = queue.splice(0, queue.length - MAX_PENDING_LOGS).length;
    globals.__htkDroppedLogs = (globals.__htkDroppedLogs ?? 0) + dropped;
  }
  const now = Date.now();
  if (queue.length >= 250 || now - (globals.__htkLastFlushAt ?? 0) >= 1000) {
    globals.__htkLastFlushAt = now;
    void flushGatewayLogs();
  }
}

async function drainLogs(): Promise<void> {
  const queue = (globals.__htkLogs ??= []);
  const db = await getDb();
  for (let batch = 0; batch < MAX_BATCHES_PER_FLUSH; batch += 1) {
    const chunk = queue.splice(0, LOG_BATCH);
    if (chunk.length === 0) break;
    try {
      await db.query(
        `insert into gateway_logs (
           id, user_id, key_id, endpoint_id, endpoint_slug, request_id, method, path,
           status, upstream_status, latency_ms, bucket_remaining, upstream, error, created_at
         )
         select * from json_populate_recordset(null::gateway_logs, $1::json)`,
        [JSON.stringify(chunk.map(toRow))],
      );
    } catch (error) {
      queue.unshift(...chunk);
      throw error;
    }
  }

  const deltas = globals.__htkQuotaDelta ?? new Map<string, QuotaDelta>();
  const entries = [...deltas.entries()].sort((a, b) => a[1].period.localeCompare(b[1].period));
  for (const [composite, item] of entries) {
    const keyId = composite.slice(0, composite.lastIndexOf('|'));
    await db.query(
      `update api_keys
       set used_this_month = case when period = $2 then used_this_month + $3 else $3 end,
           period = $2,
           last_used_at = now()
       where id = $1`,
      [keyId, item.period, item.delta],
    );
    const current = deltas.get(composite);
    if (current) {
      const rest = current.delta - item.delta;
      if (rest <= 0) deltas.delete(composite);
      else deltas.set(composite, { period: current.period, delta: rest });
    }
  }

  globals.__htkFlushCount = (globals.__htkFlushCount ?? 0) + 1;
  if (globals.__htkFlushCount % 20 === 0) {
    await db.query(
      `delete from gateway_logs where id in (
         select id from (
           select id, row_number() over (partition by user_id order by created_at desc) as rn
           from gateway_logs
         ) ranked
         where ranked.rn > ${KEEP_LOGS_PER_USER}
       )`,
    );
  }

  if (usingBlob() && Date.now() - (globals.__htkLastPersistAt ?? 0) > 10_000) {
    globals.__htkLastPersistAt = Date.now();
    void saveState().catch(() => undefined);
  }
}

function toRow(log: QueuedLog): Record<string, unknown> {
  return {
    id: log.id,
    user_id: log.userId,
    key_id: log.keyId,
    endpoint_id: log.endpointId,
    endpoint_slug: log.endpointSlug,
    request_id: log.requestId,
    method: log.method,
    path: log.path,
    status: log.status,
    upstream_status: log.upstreamStatus,
    latency_ms: log.latencyMs,
    bucket_remaining: log.bucketRemaining,
    upstream: log.upstream,
    error: log.error,
    created_at: log.createdAt,
  };
}

export function flushGatewayLogs(): Promise<void> {
  const chain = (globals.__htkFlushChain ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      try {
        await drainLogs();
        if ((globals.__htkLogs?.length ?? 0) > 0) {
          globals.__htkLastFlushAt = Date.now();
          setTimeout(() => {
            void flushGatewayLogs();
          }, 25);
        }
      } catch (error) {
        logEvent('gateway_log_flush_failed', {
          level: 'warn',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  globals.__htkFlushChain = chain;
  return chain;
}

export function flushGatewayLogsIfIdle(): void {
  const pending = globals.__htkLogs?.length ?? 0;
  if (pending === 0) return;
  if (Date.now() - (globals.__htkLastFlushAt ?? 0) < 700) return;
  globals.__htkLastFlushAt = Date.now();
  void flushGatewayLogs();
}

export function resetGatewayState(): void {
  globals.__htkKeyCache?.clear();
  globals.__htkEndpointCache?.clear();
  globals.__htkBuckets?.clear();
  globals.__htkQuotaState?.clear();
  globals.__htkQuotaDelta?.clear();
  if (globals.__htkLogs) globals.__htkLogs.length = 0;
  globals.__htkFlushChain = Promise.resolve();
  globals.__htkLastFlushAt = 0;
  globals.__htkFlushCount = 0;
  globals.__htkDroppedLogs = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bodyPreview(body: Buffer | null): unknown {
  if (!body || body.length === 0) return null;
  const text = body.toString('utf8');
  if (text.length > 2048) return `${text.slice(0, 2048)}…`;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const FORWARD_HEADERS = ['content-type', 'accept', 'idempotency-key', 'user-agent'];

export async function handleGatewayRequest(req: Request, slug: string): Promise<Response> {
  const started = performance.now();
  const requestId = randomUUID();
  const url = new URL(req.url);
  const method = req.method;

  let key: ApiKeyRecord | null = null;
  let endpoint: EndpointRecord | null = null;
  let upstreamStatus: number | null = null;
  let upstream = 'none';
  let bucketRemaining: number | null = null;
  let quotaRemaining: number | null = null;
  let rateLimit = { limit: 0, remaining: 0, resetSeconds: 0 };
  let logged = false;

  const baseHeaders = (): Headers => {
    const headers = new Headers({ 'cache-control': 'no-store', 'x-request-id': requestId });
    if (key) {
      headers.set('x-gateway-key', key.keyPrefix);
      headers.set('x-ratelimit-limit', String(rateLimit.limit));
      headers.set('x-ratelimit-remaining', String(rateLimit.remaining));
      if (rateLimit.resetSeconds > 0) headers.set('x-ratelimit-reset', String(rateLimit.resetSeconds));
      if (quotaRemaining !== null) headers.set('x-quota-remaining', String(quotaRemaining));
    }
    return headers;
  };

  const writeLog = (status: number, error: string | null) => {
    if (logged || !key || !endpoint) return;
    logged = true;
    queueGatewayLog({
      userId: key.userId,
      keyId: key.id,
      endpointId: endpoint.id,
      endpointSlug: endpoint.slug,
      requestId,
      method,
      path: url.pathname,
      status,
      upstreamStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      bucketRemaining,
      upstream,
      error,
    });
  };

  const json = (
    status: number,
    payload: unknown,
    code: string | null = null,
    headers: Record<string, string> = {},
  ): Response => {
    const out = baseHeaders();
    for (const [name, value] of Object.entries(headers)) out.set(name, value);
    writeLog(status, code);
    return Response.json(payload, { status, headers: out });
  };

  try {
    const secret = parseBearer(req.headers.get('authorization'));
    if (!secret) {
      return json(401, {
        error: { code: 'missing_key', message: 'Gửi header Authorization: Bearer <api key>.', requestId },
      });
    }

    key = await resolveApiKey(secret);
    if (!key || key.revokedAt) {
      key = null;
      return json(401, {
        error: { code: 'invalid_key', message: 'API key không hợp lệ hoặc đã bị thu hồi.', requestId },
      });
    }

    endpoint = await resolveEndpoint(slug);
    if (!endpoint || endpoint.userId !== key.userId) {
      endpoint = null;
      return json(404, {
        error: { code: 'endpoint_not_found', message: 'Endpoint không tồn tại.', requestId },
      });
    }

    upstream = endpoint.upstreamUrl;
    rateLimit = { limit: key.capacity, remaining: key.capacity, resetSeconds: 0 };

    if (!endpoint.enabled) {
      return json(503, {
        error: { code: 'endpoint_disabled', message: 'Endpoint đang tạm dừng nhận traffic.', requestId },
      }, 'endpoint_disabled');
    }

    const bucket = consumeBucket(key, endpoint);
    bucketRemaining = bucket.remaining;
    rateLimit.remaining = bucket.remaining;
    if (!bucket.allowed) {
      const retryAfter = Math.max(1, Math.ceil(bucket.retryAfterMs / 1000));
      rateLimit.resetSeconds = retryAfter;
      return json(
        429,
        {
          error: {
            code: 'rate_limited',
            message: `Token bucket cạn. Thử lại sau ${retryAfter} giây.`,
            retryAfter,
            requestId,
          },
        },
        'rate_limited',
        { 'retry-after': String(retryAfter) },
      );
    }

    const quota = consumeQuotaFor(key);
    quotaRemaining = quota.remaining;
    if (!quota.allowed) {
      return json(
        429,
        {
          error: {
            code: 'quota_exceeded',
            message: `Đã dùng hết ${key.quotaMonthly} request của tháng ${quota.period}.`,
            requestId,
          },
        },
        'quota_exceeded',
      );
    }

    let body: Buffer | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = Buffer.from(await req.arrayBuffer());
      if (raw.byteLength > MAX_REQUEST_BYTES) {
        return json(413, {
          error: { code: 'payload_too_large', message: 'Body vượt quá 128 KB.', requestId },
        }, 'payload_too_large');
      }
      body = raw;
    }

    if (endpoint.upstreamUrl.startsWith('sandbox://')) {
      const kind = endpoint.upstreamUrl.slice('sandbox://'.length).replace(/\/+$/, '');
      if (kind === 'fail') {
        upstreamStatus = 503;
        return json(503, {
          error: {
            code: 'upstream_unavailable',
            message: 'Upstream sandbox cố tình trả 503 để kiểm tra error rate.',
            requestId,
          },
          upstream: endpoint.upstreamUrl,
        }, 'upstream_unavailable');
      }
      if (kind !== 'echo' && kind !== 'slow') {
        return json(502, {
          error: { code: 'sandbox_unknown', message: `Sandbox "${kind}" không được hỗ trợ.`, requestId },
        }, 'sandbox_unknown');
      }
      if (kind === 'slow') await sleep(35);
      upstreamStatus = 200;
      return json(200, {
        echo: {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          body: bodyPreview(body),
        },
        gateway: {
          requestId,
          key: key.keyPrefix,
          upstream: endpoint.upstreamUrl,
          bucketRemaining,
          quotaRemaining,
        },
        ts: new Date().toISOString(),
      });
    }

    const check = checkUpstreamUrl(endpoint.upstreamUrl);
    if (!check.ok) {
      return json(502, {
        error: { code: 'upstream_invalid', message: check.reason, requestId },
      }, 'upstream_invalid');
    }

    const target = check.url;
    target.search = url.search;
    const forward = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = req.headers.get(name);
      if (value) forward.set(name, value);
    }
    forward.set('x-forwarded-for', clientIp(req));
    forward.set('x-gateway-request-id', requestId);

    try {
      const response = await fetch(target, {
        method,
        headers: forward,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(endpoint.timeoutMs),
        redirect: 'manual',
      });
      upstreamStatus = response.status;
      const buffer = await response.arrayBuffer();
      const headers = baseHeaders();
      headers.set('x-upstream-status', String(response.status));
      const contentType = response.headers.get('content-type');
      if (contentType) headers.set('content-type', contentType);
      writeLog(response.status, null);
      const passthrough =
        response.status === 204 || response.status === 304 ? null : new Uint8Array(buffer);
      return new Response(passthrough, { status: response.status, headers });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return json(
        timedOut ? 504 : 502,
        {
          error: {
            code: timedOut ? 'upstream_timeout' : 'upstream_error',
            message: timedOut
              ? `Upstream không phản hồi trong ${endpoint.timeoutMs} ms.`
              : 'Không gọi được upstream.',
            requestId,
          },
        },
        timedOut ? 'upstream_timeout' : 'upstream_error',
      );
    }
  } catch (error) {
    logEvent('gateway_error', {
      level: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return json(500, {
      error: { code: 'internal_error', message: 'Gateway gặp lỗi xử lý.', requestId },
    }, 'internal_error');
  }
}

export function currentPeriod(): string {
  return periodOf();
}

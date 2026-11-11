import type { PGlite } from '@electric-sql/pglite';
import { DEMO_API_KEY, DEMO_EMAIL, DEMO_PASSWORD } from './demo';
import { hashApiKey, keyPrefix } from './keys';
import { hashPassword } from './password';
import { periodOf } from './tokens';

export { DEMO_EMAIL, DEMO_PASSWORD };

const LEGACY_KEY = 'htk_live_legacy_staging_51d0c8a4';

type SeedEndpoint = {
  id: string;
  slug: string;
  name: string;
  upstreamUrl: string;
  timeoutMs: number;
  enabled: boolean;
};

export const SEED_ENDPOINTS: SeedEndpoint[] = [
  {
    id: 'ep-demo-orders',
    slug: 'orders',
    name: 'Orders API (sandbox echo)',
    upstreamUrl: 'sandbox://echo',
    timeoutMs: 3000,
    enabled: true,
  },
  {
    id: 'ep-demo-catalog',
    slug: 'catalog',
    name: 'Catalog API (sandbox chậm 35 ms)',
    upstreamUrl: 'sandbox://slow',
    timeoutMs: 3000,
    enabled: true,
  },
  {
    id: 'ep-demo-reports',
    slug: 'reports',
    name: 'Reports API (sandbox lỗi 503)',
    upstreamUrl: 'sandbox://fail',
    timeoutMs: 3000,
    enabled: true,
  },
];

function seedLogRows(now: number) {
  const rows: Record<string, unknown>[] = [];
  const total = 96;
  for (let i = 0; i < total; i += 1) {
    const minuteAgo = Math.floor(i / 7);
    const createdAt = new Date(now - minuteAgo * 60_000 - (i % 7) * 5_000).toISOString();
    const isFailure = i % 10 === 7;
    const isLimited = !isFailure && i % 13 === 5;
    const endpoint = isFailure ? SEED_ENDPOINTS[2] : i % 4 === 0 ? SEED_ENDPOINTS[1] : SEED_ENDPOINTS[0];
    const method = i % 6 === 0 ? 'POST' : 'GET';
    rows.push({
      id: `seed-log-${i}`,
      user_id: 'u-gateway',
      key_id: 'k-demo-prod',
      endpoint_id: endpoint.id,
      endpoint_slug: endpoint.slug,
      request_id: `seed-${i}`,
      method,
      path: `/api/gw/${endpoint.slug}`,
      status: isFailure ? 503 : isLimited ? 429 : 200,
      upstream_status: isFailure ? 503 : isLimited ? null : 200,
      latency_ms: isFailure ? 12 + (i % 5) : isLimited ? 2 : 5 + ((i * 7) % 44),
      bucket_remaining: isLimited ? 0 : 20 - (i % 14),
      upstream: endpoint.upstreamUrl,
      error: isFailure ? 'upstream_unavailable' : isLimited ? 'rate_limited' : null,
      created_at: createdAt,
    });
  }
  return rows;
}

export async function seedDemo(db: PGlite): Promise<void> {
  const existing = await db.query<{ n: number }>('select count(*)::int as n from users');
  if (Number(existing.rows[0]?.n ?? 0) > 0) return;

  const now = Date.now();
  const password = await hashPassword(DEMO_PASSWORD);

  await db.query(
    'insert into users (id, email, name, password_hash, created_at) values ($1,$2,$3,$4,$5)',
    ['u-gateway', DEMO_EMAIL, 'HTK Gateway Demo', password, new Date(now - 30 * 86_400_000).toISOString()],
  );

  await db.query(
    `insert into api_keys (
       id, user_id, name, key_prefix, key_hash, capacity, refill_per_sec, quota_monthly,
       used_this_month, period, revoked_at, last_used_at, created_at
     ) values
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13),
       ($14,$2,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [
      'k-demo-prod',
      'u-gateway',
      'Production server',
      keyPrefix(DEMO_API_KEY),
      hashApiKey(DEMO_API_KEY),
      20,
      10,
      50_000,
      1_240,
      periodOf(),
      null,
      new Date(now - 4 * 60_000).toISOString(),
      new Date(now - 21 * 86_400_000).toISOString(),
      'k-demo-legacy',
      'Old staging',
      keyPrefix(LEGACY_KEY),
      hashApiKey(LEGACY_KEY),
      5,
      2,
      10_000,
      10_000,
      periodOf(),
      new Date(now - 12 * 86_400_000).toISOString(),
      new Date(now - 20 * 86_400_000).toISOString(),
      new Date(now - 25 * 86_400_000).toISOString(),
    ],
  );

  for (const endpoint of SEED_ENDPOINTS) {
    await db.query(
      `insert into endpoints (id, user_id, slug, name, upstream_url, timeout_ms, enabled, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        endpoint.id,
        'u-gateway',
        endpoint.slug,
        endpoint.name,
        endpoint.upstreamUrl,
        endpoint.timeoutMs,
        endpoint.enabled,
        new Date(now - 20 * 86_400_000).toISOString(),
      ],
    );
  }

  await db.query(
    `insert into gateway_logs (
       id, user_id, key_id, endpoint_id, endpoint_slug, request_id, method, path,
       status, upstream_status, latency_ms, bucket_remaining, upstream, error, created_at
     )
     select * from json_populate_recordset(null::gateway_logs, $1::json)`,
    [JSON.stringify(seedLogRows(now))],
  );
}

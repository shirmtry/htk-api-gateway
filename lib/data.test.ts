import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'htk-gateway-test-'));
process.env.PGLITE_DIR = dir;

let db: PGlite;
let data: typeof import('./data');
let gateway: typeof import('./gateway');
let limits: typeof import('./rate-limit');
let keyLib: typeof import('./keys');
let demo: typeof import('./demo');

beforeAll(async () => {
  const dbModule = await import('./db');
  gateway = await import('./gateway');
  data = await import('./data');
  limits = await import('./rate-limit');
  keyLib = await import('./keys');
  demo = await import('./demo');
  db = await dbModule.getDb();
});

afterAll(async () => {
  await gateway.flushGatewayLogs();
  await db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may keep the WASM handle briefly; the temp dir is disposable.
  }
});

async function resetRuntime() {
  await gateway.flushGatewayLogs();
  gateway.resetGatewayState();
}

function gwRequest(
  slug: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; secret?: string } = {},
): Request {
  return new Request(`http://localhost/api/gw/${slug}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      authorization: `Bearer ${init.secret ?? demo.DEMO_API_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function countRows(table: string): Promise<number> {
  const result = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

async function keyUsage(keyId: string): Promise<number> {
  const result = await db.query<{ used_this_month: number }>(
    'select used_this_month from api_keys where id = $1',
    [keyId],
  );
  return Number(result.rows[0]?.used_this_month ?? 0);
}

describe('dữ liệu seed', () => {
  it('seed 1 người dùng, 2 API key, 3 endpoint và 96 log', async () => {
    expect(await countRows('users')).toBe(1);
    expect(await countRows('api_keys')).toBe(2);
    expect(await countRows('endpoints')).toBe(3);
    expect(await countRows('gateway_logs')).toBe(96);
  });

  it('dashboard tổng hợp đúng log 15 phút, lỗi và p95', async () => {
    const metrics = await data.getMetrics('u-gateway');
    expect(metrics.requests15m).toBe(96);
    expect(metrics.errors15m).toBe(9);
    expect(metrics.rateLimited15m).toBe(6);
    expect(metrics.p50).not.toBeNull();
    expect(metrics.p95).not.toBeNull();
    expect(metrics.recent).toHaveLength(20);
    expect(metrics.series).toHaveLength(15);
    expect(metrics.topEndpoints).toHaveLength(3);
    const orders = metrics.topEndpoints.find((item) => item.slug === 'orders');
    expect(orders?.total).toBeGreaterThan(30);
    expect(metrics.errorRate1m).toBeGreaterThanOrEqual(0);
  });

  it('danh sách key không lộ hash hay secret', async () => {
    const keys = await data.listApiKeys('u-gateway');
    expect(keys).toHaveLength(2);
    const prod = keys.find((key) => key.id === 'k-demo-prod');
    expect(prod?.keyPrefix).toBe('htk_live_demo');
    expect(prod?.quotaRemaining).toBe(50_000 - 1_240);
    const legacy = keys.find((key) => key.id === 'k-demo-legacy');
    expect(legacy?.revokedAt).not.toBeNull();
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(demo.DEMO_API_KEY);
    expect(serialized).not.toContain(keyLib.hashApiKey(demo.DEMO_API_KEY));
    expect(serialized).not.toContain('keyHash');
  });

  it('resolve key đúng và trả null với key lạ', async () => {
    const record = await gateway.resolveApiKey(demo.DEMO_API_KEY);
    expect(record?.id).toBe('k-demo-prod');
    expect(record?.capacity).toBe(20);
    expect(await gateway.resolveApiKey('htk_live_does_not_exist')).toBeNull();
  });
});

describe('quản lý API key', () => {
  it('tạo key trả secret đúng một lần và lưu hash', async () => {
    const { key, secret } = await data.createApiKey('u-gateway', {
      name: 'CI runner',
      capacity: 50,
      refillPerSec: 25,
      quotaMonthly: 20_000,
    });
    expect(secret).toMatch(/^htk_live_/);
    expect(key.keyPrefix).toBe(keyLib.keyPrefix(secret));
    expect(key.quotaRemaining).toBe(20_000);
    const keys = await data.listApiKeys('u-gateway');
    expect(JSON.stringify(keys)).not.toContain(secret);
    const resolved = await gateway.resolveApiKey(secret);
    expect(resolved?.id).toBe(key.id);

    await data.revokeApiKey('u-gateway', key.id);
    const after = (await data.listApiKeys('u-gateway')).find((item) => item.id === key.id);
    expect(after?.revokedAt).not.toBeNull();
  });

  it('thu hồi key của người khác trả 404', async () => {
    await db.query('insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)', [
      'u-other',
      'other@htk.dev',
      'Other Team',
      'scrypt$x$y',
    ]);
    const created = await data.createApiKey('u-other', {
      name: 'Other key',
      capacity: 10,
      refillPerSec: 5,
      quotaMonthly: 1_000,
    });
    await expect(data.revokeApiKey('u-gateway', created.key.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('quản lý endpoint', () => {
  it('chuẩn hoá slug, chặn upstream nội bộ và slug trùng', async () => {
    const endpoint = await data.createEndpoint('u-gateway', {
      slug: 'My Search API',
      name: 'Search API',
      upstreamUrl: 'sandbox://echo',
      timeoutMs: 2500,
    });
    expect(endpoint.slug).toBe('my-search-api');

    await expect(
      data.createEndpoint('u-gateway', {
        slug: 'local',
        name: 'Local',
        upstreamUrl: 'https://127.0.0.1:9000',
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      data.createEndpoint('u-gateway', {
        slug: 'bad',
        name: 'Bad',
        upstreamUrl: 'sandbox://nope',
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      data.createEndpoint('u-gateway', {
        slug: 'my-search-api',
        name: 'Duplicate',
        upstreamUrl: 'sandbox://echo',
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await data.deleteEndpoint('u-gateway', endpoint.id);
    expect((await data.listEndpoints('u-gateway')).some((item) => item.id === endpoint.id)).toBe(false);
  });

  it('không sửa được endpoint của người khác', async () => {
    const foreign = await data.createEndpoint('u-other', {
      slug: 'foreign-api',
      name: 'Foreign API',
      upstreamUrl: 'sandbox://echo',
      timeoutMs: 3000,
    });
    await expect(
      data.updateEndpoint('u-gateway', foreign.id, { enabled: false }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(data.deleteEndpoint('u-gateway', foreign.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('gateway runtime', () => {
  it('chuyển tiếp sandbox echo và trả header rate limit', async () => {
    await resetRuntime();
    const response = await gateway.handleGatewayRequest(
      gwRequest('orders', { method: 'POST', body: JSON.stringify({ amount: 120 }) }),
      'orders',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-limit')).toBe('20');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('19');
    expect(response.headers.get('x-gateway-key')).toBe('htk_live_demo');
    expect(Number(response.headers.get('x-quota-remaining'))).toBe(48_759);
    const payload = (await response.json()) as {
      echo: { method: string; body: unknown };
    };
    expect(payload.echo.method).toBe('POST');
    expect(payload.echo.body).toEqual({ amount: 120 });
  });

  it('cạn token bucket trả 429 kèm retry-after', async () => {
    await resetRuntime();
    for (let i = 0; i < 20; i += 1) {
      const response = await gateway.handleGatewayRequest(gwRequest('orders'), 'orders');
      expect(response.status).toBe(200);
    }
    const blocked = await gateway.handleGatewayRequest(gwRequest('orders'), 'orders');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const payload = (await blocked.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('rate_limited');
  });

  it('hạn mức tháng đã dùng hết trả 429 quota_exceeded', async () => {
    await resetRuntime();
    const { key, secret } = await data.createApiKey('u-gateway', {
      name: 'Quota test',
      capacity: 10,
      refillPerSec: 10,
      quotaMonthly: 100,
    });
    await db.query('update api_keys set used_this_month = 100, period = $2 where id = $1', [
      key.id,
      gateway.currentPeriod(),
    ]);
    gateway.resetGatewayState();
    const response = await gateway.handleGatewayRequest(
      gwRequest('orders', { secret }),
      'orders',
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('x-quota-remaining')).toBe('0');
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('quota_exceeded');
  });

  it('key đã thu hồi và endpoint lạ bị từ chối', async () => {
    await resetRuntime();
    const { key, secret } = await data.createApiKey('u-gateway', {
      name: 'Revoked test',
      capacity: 10,
      refillPerSec: 10,
      quotaMonthly: 1_000,
    });
    await data.revokeApiKey('u-gateway', key.id);
    gateway.resetGatewayState();
    const revoked = await gateway.handleGatewayRequest(gwRequest('orders', { secret }), 'orders');
    expect(revoked.status).toBe(401);

    const missingSecret = await gateway.handleGatewayRequest(gwRequest('orders', { secret: 'nope' }), 'orders');
    expect(missingSecret.status).toBe(401);

    const missingEndpoint = await gateway.handleGatewayRequest(gwRequest('nope'), 'nope');
    expect(missingEndpoint.status).toBe(404);

    const other = await data.createApiKey('u-other', {
      name: 'Other production',
      capacity: 10,
      refillPerSec: 10,
      quotaMonthly: 1_000,
    });
    const foreign = await gateway.handleGatewayRequest(
      gwRequest('orders', { secret: other.secret }),
      'orders',
    );
    expect(foreign.status).toBe(404);
  });

  it('endpoint tạm dừng trả 503 và không tiêu token', async () => {
    await resetRuntime();
    await data.updateEndpoint('u-gateway', 'ep-demo-orders', { enabled: false });
    gateway.resetGatewayState();
    const disabled = await gateway.handleGatewayRequest(gwRequest('orders'), 'orders');
    expect(disabled.status).toBe(503);
    const payload = (await disabled.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('endpoint_disabled');

    await data.updateEndpoint('u-gateway', 'ep-demo-orders', { enabled: true });
    gateway.resetGatewayState();
    const enabled = await gateway.handleGatewayRequest(gwRequest('orders'), 'orders');
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('x-ratelimit-remaining')).toBe('19');
  });

  it('body quá 128 KB bị chặn 413', async () => {
    await resetRuntime();
    const response = await gateway.handleGatewayRequest(
      gwRequest('orders', { method: 'POST', body: 'x'.repeat(129 * 1024) }),
      'orders',
    );
    expect(response.status).toBe(413);
  });

  it('flush ghi log và cộng dồn hạn mức đã dùng', async () => {
    await resetRuntime();
    const logsBefore = await countRows('gateway_logs');
    const usedBefore = await keyUsage('k-demo-prod');
    for (let i = 0; i < 5; i += 1) {
      const response = await gateway.handleGatewayRequest(gwRequest('orders'), 'orders');
      expect(response.status).toBe(200);
    }
    await gateway.flushGatewayLogs();
    expect(await countRows('gateway_logs')).toBe(logsBefore + 5);
    expect(await keyUsage('k-demo-prod')).toBe(usedBefore + 5);
  });
});

describe('giới hạn tần suất', () => {
  it('chặn sau khi vượt ngưỡng trong cùng cửa sổ', async () => {
    const key = `test-${Date.now()}`;
    expect((await limits.hitLimit(key, 2, 60)).ok).toBe(true);
    expect((await limits.hitLimit(key, 2, 60)).ok).toBe(true);
    const blocked = await limits.hitLimit(key, 2, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });
});

#!/usr/bin/env node
// Stress the gateway hot path with keep-alive sockets and report real client-side
// throughput/latency. Requires a running production server (npm start).
import http from 'node:http';

const base = process.argv[2] ?? 'http://localhost:3109';
const total = Number(process.argv[3] ?? 20_000);
const concurrency = Number(process.argv[4] ?? 200);
const slug = `stress-${Date.now().toString(36)}`;
const url = new URL(`${base}/api/gw/${slug}`);

function jsonRequest(path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      new URL(path, base),
      {
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(cookie ? { cookie } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const email = `stress-${Date.now()}@htk.dev`;
  const password = 'Demo12345!';
  const register = await jsonRequest('/api/auth/register', {
    method: 'POST',
    body: { email, password, name: 'Stress Runner' },
  });
  if (register.status !== 200) throw new Error(`register failed: ${register.status} ${register.body}`);
  const cookie = (register.headers['set-cookie'] ?? [])
    .map((line) => line.split(';')[0])
    .join('; ');

  const endpoint = await jsonRequest('/api/endpoints', {
    method: 'POST',
    cookie,
    body: { slug, name: 'Stress echo', upstreamUrl: 'sandbox://echo', timeoutMs: 3000 },
  });
  if (endpoint.status !== 201) throw new Error(`endpoint failed: ${endpoint.status} ${endpoint.body}`);

  const created = await jsonRequest('/api/keys', {
    method: 'POST',
    cookie,
    body: { name: 'Stress run', capacity: 10_000, refillPerSec: 5_000, quotaMonthly: 100_000_000 },
  });
  if (created.status !== 201) throw new Error(`key failed: ${created.status} ${created.body}`);
  const { key, secret } = JSON.parse(created.body);

  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const latencies = [];
  let completed = 0;
  let failed = 0;
  const statuses = new Map();

  function one() {
    return new Promise((resolve) => {
      const started = performance.now();
      const req = http.request(
        url,
        { agent, method: 'GET', headers: { authorization: `Bearer ${secret}` }, timeout: 10_000 },
        (res) => {
          res.resume();
          res.on('end', () => {
            latencies.push(performance.now() - started);
            statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
            resolve();
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => {
        failed += 1;
        resolve();
      });
      req.end();
    });
  }

  console.log(`[setup] user=${email} key=${key.id} capacity=${key.capacity}`);

  const warmup = Math.min(400, total);
  for (let i = 0; i < warmup; i += 8) {
    await Promise.all(Array.from({ length: Math.min(8, warmup - i) }, one));
  }
  latencies.length = 0;
  statuses.clear();
  failed = 0;

  const startedAt = performance.now();
  async function worker() {
    while (true) {
      const index = completed;
      if (index >= total) return;
      completed += 1;
      await one();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - startedAt) / 1000;

  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] ?? 0;
  const rps = latencies.length / elapsed;
  console.log(
    `[run] ${latencies.length} requests, concurrency ${concurrency}, ${elapsed.toFixed(2)}s\n` +
      `RPS ${rps.toFixed(1)} | p50 ${percentile(0.5).toFixed(1)}ms | p95 ${percentile(0.95).toFixed(1)}ms | ` +
      `p99 ${percentile(0.99).toFixed(1)}ms | errors ${failed}\n` +
      `statuses ${JSON.stringify(Object.fromEntries(statuses))}`,
  );

  agent.destroy();
  await jsonRequest(`/api/keys/${key.id}`, { method: 'DELETE', cookie });
  const endpointId = JSON.parse(endpoint.body).endpoint.id;
  await jsonRequest(`/api/endpoints/${endpointId}`, { method: 'DELETE', cookie });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const health = await jsonRequest('/api/health');
  console.log(`[server] ${health.body}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

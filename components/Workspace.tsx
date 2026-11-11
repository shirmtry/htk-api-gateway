'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type ApiKey = {
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

type Endpoint = {
  id: string;
  slug: string;
  name: string;
  upstreamUrl: string;
  timeoutMs: number;
  enabled: boolean;
  createdAt: string;
};

type LogRow = {
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

type Metrics = {
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
  recent: LogRow[];
};

type PlayResult = {
  status: number;
  ms: number;
  headers: [string, string][];
  body: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Cần đăng nhập.');
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: { message: string } })
    | null;
  if (!response.ok) throw new Error(data?.error?.message ?? 'Có lỗi xảy ra, thử lại sau.');
  return data as T;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });
}

function statusClass(status: number): string {
  if (status >= 500) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  if (status === 429) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  if (status >= 400) return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
  return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
}

function formatNumber(value: number): string {
  return value.toLocaleString('vi-VN');
}

export function Workspace({ user }: { user: { id: string; email: string; name: string } }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);

  const [keyName, setKeyName] = useState('CI runner');
  const [capacity, setCapacity] = useState('20');
  const [refill, setRefill] = useState('10');
  const [quota, setQuota] = useState('50000');
  const [keyPending, setKeyPending] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [epSlug, setEpSlug] = useState('');
  const [epName, setEpName] = useState('');
  const [epUpstream, setEpUpstream] = useState('sandbox://echo');
  const [epTimeout, setEpTimeout] = useState('3000');
  const [epPending, setEpPending] = useState(false);

  const [playSlug, setPlaySlug] = useState('orders');
  const [playMethod, setPlayMethod] = useState('GET');
  const [playKey, setPlayKey] = useState('');
  const [playBody, setPlayBody] = useState('{"orderId":"ord_42"}');
  const [playPending, setPlayPending] = useState(false);
  const [playResult, setPlayResult] = useState<PlayResult | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [metricData, keyData, endpointData] = await Promise.all([
        api<Metrics>('/api/metrics'),
        api<{ keys: ApiKey[] }>('/api/keys'),
        api<{ endpoints: Endpoint[] }>('/api/endpoints'),
      ]);
      setMetrics(metricData);
      setKeys(keyData.keys);
      setEndpoints(endpointData.endpoints);
      setPlaySlug((current) => {
        if (endpointData.endpoints.some((endpoint) => endpoint.slug === current)) return current;
        return endpointData.endpoints[0]?.slug ?? current;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được workspace.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMetrics = useCallback(async () => {
    try {
      setMetrics(await api<Metrics>('/api/metrics'));
    } catch {
      // The next poll retries; do not flash an error banner for a transient miss.
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    pollTimer.current = setInterval(() => {
      void refreshMetrics();
    }, 5000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [refreshMetrics]);

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    setKeyPending(true);
    setError(null);
    setNotice(null);
    setNewSecret(null);
    try {
      const result = await api<{ key: ApiKey; secret: string }>('/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: keyName,
          capacity: Number(capacity),
          refillPerSec: Number(refill),
          quotaMonthly: Number(quota),
        }),
      });
      setNewSecret(result.secret);
      setCopied(false);
      setNotice(`Đã tạo key "${result.key.name}". Secret chỉ hiện một lần.`);
      setKeys((current) => [result.key, ...current]);
      void refreshMetrics();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tạo được key.');
    } finally {
      setKeyPending(false);
    }
  }

  async function revokeKey(key: ApiKey) {
    if (!window.confirm(`Thu hồi key "${key.name}"? Request dùng key này sẽ nhận 401.`)) return;
    setBusyId(key.id);
    setError(null);
    try {
      const result = await api<{ key: ApiKey }>(`/api/keys/${key.id}`, { method: 'DELETE' });
      setKeys((current) => current.map((item) => (item.id === key.id ? result.key : item)));
      setNotice(`Đã thu hồi key ${key.keyPrefix}….`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thu hồi được key.');
    } finally {
      setBusyId(null);
    }
  }

  async function createEndpoint(event: React.FormEvent) {
    event.preventDefault();
    setEpPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ endpoint: Endpoint }>('/api/endpoints', {
        method: 'POST',
        body: JSON.stringify({
          slug: epSlug,
          name: epName,
          upstreamUrl: epUpstream,
          timeoutMs: Number(epTimeout),
        }),
      });
      setEndpoints((current) => [...current, result.endpoint]);
      setNotice(`Đã thêm endpoint /api/gw/${result.endpoint.slug}.`);
      setEpSlug('');
      setEpName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tạo được endpoint.');
    } finally {
      setEpPending(false);
    }
  }

  async function toggleEndpoint(endpoint: Endpoint) {
    setBusyId(endpoint.id);
    setError(null);
    try {
      const result = await api<{ endpoint: Endpoint }>(`/api/endpoints/${endpoint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !endpoint.enabled }),
      });
      setEndpoints((current) =>
        current.map((item) => (item.id === endpoint.id ? result.endpoint : item)),
      );
      setNotice(
        result.endpoint.enabled
          ? `Đã bật lại ${endpoint.slug}.`
          : `Đã tạm dừng ${endpoint.slug}; request mới nhận 503.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được endpoint.');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteEndpoint(endpoint: Endpoint) {
    if (!window.confirm(`Xoá endpoint "${endpoint.slug}"?`)) return;
    setBusyId(endpoint.id);
    setError(null);
    try {
      await api(`/api/endpoints/${endpoint.id}`, { method: 'DELETE' });
      setEndpoints((current) => current.filter((item) => item.id !== endpoint.id));
      setNotice(`Đã xoá endpoint ${endpoint.slug}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không xoá được endpoint.');
    } finally {
      setBusyId(null);
    }
  }

  async function copySecret() {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
    } catch {
      setError('Trình duyệt không cho phép sao chép. Hãy chọn và copy thủ công.');
    }
  }

  async function sendPlayground(event: React.FormEvent) {
    event.preventDefault();
    setPlayPending(true);
    setPlayError(null);
    setPlayResult(null);
    const started = performance.now();
    try {
      const response = await fetch(`/api/gw/${playSlug}`, {
        method: playMethod,
        headers: {
          authorization: `Bearer ${playKey.trim()}`,
          ...(playMethod === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        body: playMethod === 'GET' ? undefined : playBody,
      });
      const text = await response.text();
      const interesting = [
        'x-request-id',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'x-quota-remaining',
        'x-upstream-status',
        'retry-after',
      ];
      const headers = interesting
        .map((name) => [name, response.headers.get(name)] as [string, string | null])
        .filter((entry): entry is [string, string] => Boolean(entry[1]));
      setPlayResult({
        status: response.status,
        ms: Math.round(performance.now() - started),
        headers,
        body: text,
      });
      window.setTimeout(() => void refreshMetrics(), 900);
    } catch {
      setPlayError('Không gọi được gateway. Kiểm tra key và kết nối.');
    } finally {
      setPlayPending(false);
    }
  }

  const maxSeries = Math.max(1, ...(metrics?.series.map((point) => point.total) ?? []));
  const activeKeys = keys.filter((key) => !key.revokedAt).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-lg font-black text-accent">
            H
          </span>
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-200">HTK Gateway</p>
            <p className="text-xs text-slate-500">{user.email}</p>
          </div>
        </div>
        <button className="btn-ghost" type="button" onClick={() => void logout()}>
          Đăng xuất
        </button>
      </header>

      <div aria-live="polite" role="status" className="mt-4 space-y-2">
        {error && (
          <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {notice}
          </p>
        )}
      </div>

      {loading ? (
        <p className="mt-10 text-sm text-slate-400">Đang tải workspace…</p>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Chỉ số traffic">
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-slate-500">Request / phút</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">{metrics?.requests1m ?? 0}</p>
              <p className="mt-1 text-xs text-slate-400">
                {metrics?.rps1m.toFixed(2) ?? '0.00'} req/s trung bình 60 giây
              </p>
            </div>
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-slate-500">Error rate 1 phút</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-rose-300">
                {((metrics?.errorRate1m ?? 0) * 100).toFixed(1)}%
              </p>
              <p className="mt-1 text-xs text-slate-400">{metrics?.errors1m ?? 0} response 5xx</p>
            </div>
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-slate-500">Latency p50 / p95</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                {metrics?.p50 ?? '—'}
                <span className="text-lg text-slate-400"> / {metrics?.p95 ?? '—'} ms</span>
              </p>
              <p className="mt-1 text-xs text-slate-400">Cửa sổ 15 phút, gồm cả 429</p>
            </div>
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-slate-500">15 phút gần nhất</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">{metrics?.requests15m ?? 0}</p>
              <p className="mt-1 text-xs text-slate-400">
                {metrics?.errors15m ?? 0} lỗi · {metrics?.rateLimited15m ?? 0} bị chặn
              </p>
              {metrics && metrics.droppedLogs > 0 && (
                <p className="mt-1 text-[11px] text-amber-300/80">
                  Buffer đã bỏ {metrics.droppedLogs} log khi quá tải
                </p>
              )}
            </div>
          </section>

          <section className="mt-5 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <div className="card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">Throughput 15 phút</h2>
                <p className="text-xs text-slate-400">
                  {activeKeys} key đang hoạt động · log flush theo lô
                </p>
              </div>
              <div className="mt-4 flex h-36 items-end gap-1.5" aria-label="Biểu đồ request theo phút">
                {(metrics?.series ?? []).map((point, index) => {
                  const height = Math.max(3, Math.round((point.total / maxSeries) * 100));
                  const errorHeight = point.total > 0 ? Math.round((point.errors / point.total) * 100) : 0;
                  return (
                    <div key={`${point.minute}-${index}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                      <div
                        className="relative w-full rounded-md bg-accent/30"
                        style={{ height: `${height}%` }}
                        title={`${point.minute}: ${point.total} request, ${point.errors} lỗi`}
                      >
                        {errorHeight > 0 && (
                          <span
                            className="absolute inset-x-0 bottom-0 rounded-md bg-rose-400/80"
                            style={{ height: `${errorHeight}%` }}
                          />
                        )}
                      </div>
                      <span className="text-[10px] text-slate-500">{index % 3 === 0 ? point.minute : ''}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Tài khoản demo có 96 log mẫu trải 14 phút. Cột đỏ là phần response 5xx.
              </p>
            </div>

            <div className="card">
              <h2 className="text-lg font-semibold">Top endpoint</h2>
              {metrics && metrics.topEndpoints.length > 0 ? (
                <ul className="mt-3 space-y-3">
                  {metrics.topEndpoints.map((endpoint) => (
                    <li key={endpoint.slug}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate font-medium text-slate-200">{endpoint.name}</span>
                        <span className="shrink-0 tabular-nums text-slate-400">
                          {endpoint.total} · {endpoint.errors} lỗi
                        </span>
                      </div>
                      <p className="font-mono text-xs text-slate-500">/api/gw/{endpoint.slug}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-slate-400">Chưa có traffic trong 15 phút gần nhất.</p>
              )}
            </div>
          </section>

          {newSecret && (
            <section className="mt-5 card border-accent/50" aria-label="Secret mới">
              <h2 className="text-lg font-semibold text-accent">Secret mới — chỉ hiện một lần</h2>
              <p className="mt-1 text-sm text-slate-400">
                Sao chép ngay. Server chỉ lưu SHA-256 của key, không thể hiện lại secret.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-line bg-ink/70 px-3 py-2 font-mono text-xs text-slate-100">
                  {newSecret}
                </code>
                <button className="btn-ghost" type="button" onClick={() => void copySecret()}>
                  {copied ? 'Đã copy' : 'Copy'}
                </button>
                <button className="btn-ghost" type="button" onClick={() => setNewSecret(null)}>
                  Đã lưu, ẩn đi
                </button>
              </div>
            </section>
          )}

          <section className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="card">
              <h2 className="text-lg font-semibold">API key</h2>
              <p className="mt-1 text-xs text-slate-400">
                Capacity là burst tối đa; refill là tốc độ bền mỗi giây. Quota tính theo tháng UTC.
              </p>

              <form className="mt-4 grid grid-cols-2 gap-3" onSubmit={(event) => void createKey(event)}>
                <div className="col-span-2">
                  <label className="label" htmlFor="key-name">
                    Tên key
                  </label>
                  <input
                    id="key-name"
                    className="input"
                    value={keyName}
                    onChange={(event) => setKeyName(event.target.value)}
                    required
                    minLength={2}
                    maxLength={80}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="key-capacity">
                    Capacity
                  </label>
                  <input
                    id="key-capacity"
                    className="input"
                    type="number"
                    min={1}
                    max={10000}
                    value={capacity}
                    onChange={(event) => setCapacity(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label" htmlFor="key-refill">
                    Refill / giây
                  </label>
                  <input
                    id="key-refill"
                    className="input"
                    type="number"
                    min={1}
                    max={5000}
                    value={refill}
                    onChange={(event) => setRefill(event.target.value)}
                    required
                  />
                </div>
                <div className="col-span-2">
                  <label className="label" htmlFor="key-quota">
                    Quota tháng
                  </label>
                  <input
                    id="key-quota"
                    className="input"
                    type="number"
                    min={100}
                    max={100000000}
                    value={quota}
                    onChange={(event) => setQuota(event.target.value)}
                    required
                  />
                </div>
                <button className="btn-primary col-span-2" type="submit" disabled={keyPending}>
                  {keyPending ? 'Đang tạo…' : 'Tạo API key'}
                </button>
              </form>

              {keys.length === 0 ? (
                <p className="mt-5 text-sm text-slate-400">Chưa có key nào. Tạo key đầu tiên ở trên.</p>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th scope="col" className="pb-2 pr-3 font-medium">Key</th>
                        <th scope="col" className="pb-2 pr-3 font-medium">Quota</th>
                        <th scope="col" className="pb-2 pr-3 font-medium">Trạng thái</th>
                        <th scope="col" className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {keys.map((key) => {
                        const percent = Math.min(100, Math.round((key.usedThisMonth / key.quotaMonthly) * 100));
                        return (
                          <tr key={key.id}>
                            <td className="py-3 pr-3 align-top">
                              <p className="font-medium text-slate-200">{key.name}</p>
                              <p className="font-mono text-xs text-slate-500">{key.keyPrefix}…</p>
                              <p className="mt-0.5 text-xs text-slate-500">
                                burst {key.capacity} · {key.refillPerSec} req/s
                              </p>
                            </td>
                            <td className="py-3 pr-3 align-top">
                              <p className="tabular-nums text-xs text-slate-300">
                                {formatNumber(key.usedThisMonth)} / {formatNumber(key.quotaMonthly)}
                              </p>
                              <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-line">
                                <div
                                  className={percent >= 100 ? 'h-full bg-rose-400' : 'h-full bg-accent'}
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <p className="mt-1 text-[11px] text-slate-500">tháng {key.period}</p>
                            </td>
                            <td className="py-3 pr-3 align-top">
                              {key.revokedAt ? (
                                <span className="badge border-rose-500/30 text-rose-300">Đã thu hồi</span>
                              ) : (
                                <span className="badge border-emerald-500/30 text-emerald-300">Hoạt động</span>
                              )}
                              <p className="mt-1 text-[11px] text-slate-500">
                                {key.lastUsedAt ? `Dùng lúc ${timeOf(key.lastUsedAt)}` : 'Chưa dùng'}
                              </p>
                            </td>
                            <td className="py-3 text-right align-top">
                              {!key.revokedAt && (
                                <button
                                  className="btn-ghost px-3 py-1.5 text-xs"
                                  type="button"
                                  disabled={busyId === key.id}
                                  onClick={() => void revokeKey(key)}
                                >
                                  Thu hồi
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-lg font-semibold">Endpoint</h2>
              <p className="mt-1 text-xs text-slate-400">
                Sandbox nhận <code>sandbox://echo</code>, <code>sandbox://slow</code>,{' '}
                <code>sandbox://fail</code>. Live upstream phải là HTTPS công khai.
              </p>

              <form className="mt-4 grid grid-cols-2 gap-3" onSubmit={(event) => void createEndpoint(event)}>
                <div>
                  <label className="label" htmlFor="ep-slug">
                    Slug
                  </label>
                  <input
                    id="ep-slug"
                    className="input"
                    value={epSlug}
                    onChange={(event) => setEpSlug(event.target.value)}
                    placeholder="payments"
                    required
                    minLength={2}
                    maxLength={32}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ep-name">
                    Tên
                  </label>
                  <input
                    id="ep-name"
                    className="input"
                    value={epName}
                    onChange={(event) => setEpName(event.target.value)}
                    placeholder="Payments API"
                    required
                    minLength={2}
                    maxLength={80}
                  />
                </div>
                <div className="col-span-2">
                  <label className="label" htmlFor="ep-upstream">
                    Upstream
                  </label>
                  <input
                    id="ep-upstream"
                    className="input"
                    value={epUpstream}
                    onChange={(event) => setEpUpstream(event.target.value)}
                    required
                    maxLength={500}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ep-timeout">
                    Timeout (ms)
                  </label>
                  <input
                    id="ep-timeout"
                    className="input"
                    type="number"
                    min={100}
                    max={10000}
                    value={epTimeout}
                    onChange={(event) => setEpTimeout(event.target.value)}
                    required
                  />
                </div>
                <div className="flex items-end">
                  <button className="btn-primary w-full" type="submit" disabled={epPending}>
                    {epPending ? 'Đang thêm…' : 'Thêm endpoint'}
                  </button>
                </div>
              </form>

              {endpoints.length === 0 ? (
                <p className="mt-5 text-sm text-slate-400">Chưa có endpoint nào.</p>
              ) : (
                <ul className="mt-5 divide-y divide-line/70">
                  {endpoints.map((endpoint) => (
                    <li key={endpoint.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-200">{endpoint.name}</p>
                        <p className="font-mono text-xs text-slate-500">/api/gw/{endpoint.slug}</p>
                        <p className="truncate text-xs text-slate-500">
                          {endpoint.upstreamUrl} · {endpoint.timeoutMs} ms
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className={`btn-ghost px-3 py-1.5 text-xs ${
                            endpoint.enabled ? 'text-emerald-300' : 'text-amber-300'
                          }`}
                          type="button"
                          aria-pressed={!endpoint.enabled}
                          disabled={busyId === endpoint.id}
                          onClick={() => void toggleEndpoint(endpoint)}
                        >
                          {endpoint.enabled ? 'Đang bật' : 'Tạm dừng'}
                        </button>
                        <button
                          className="btn-ghost px-3 py-1.5 text-xs text-rose-300"
                          type="button"
                          disabled={busyId === endpoint.id}
                          onClick={() => void deleteEndpoint(endpoint)}
                        >
                          Xoá
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="mt-5 card" aria-label="Playground">
            <h2 className="text-lg font-semibold">Playground</h2>
            <p className="mt-1 text-xs text-slate-400">
              Gọi thật vào <code>/api/gw/:slug</code> bằng key của bạn. Key demo nằm trong README.
            </p>
            <form className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => void sendPlayground(event)}>
              <div>
                <label className="label" htmlFor="play-endpoint">
                  Endpoint
                </label>
                <select
                  id="play-endpoint"
                  className="input"
                  value={playSlug}
                  onChange={(event) => setPlaySlug(event.target.value)}
                >
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.slug}>
                      {endpoint.slug}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="play-method">
                  Method
                </label>
                <select
                  id="play-method"
                  className="input"
                  value={playMethod}
                  onChange={(event) => setPlayMethod(event.target.value)}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="play-key">
                  API key
                </label>
                <input
                  id="play-key"
                  className="input font-mono"
                  type="password"
                  value={playKey}
                  onChange={(event) => setPlayKey(event.target.value)}
                  placeholder="htk_live_…"
                  autoComplete="off"
                  required
                />
              </div>
              {playMethod !== 'GET' && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <label className="label" htmlFor="play-body">
                    JSON body
                  </label>
                  <textarea
                    id="play-body"
                    className="input min-h-[90px] font-mono text-xs"
                    value={playBody}
                    onChange={(event) => setPlayBody(event.target.value)}
                  />
                </div>
              )}
              <div className="sm:col-span-2 lg:col-span-4">
                <button className="btn-primary" type="submit" disabled={playPending}>
                  {playPending ? 'Đang gửi…' : 'Gửi request'}
                </button>
              </div>
            </form>

            <div aria-live="polite" role="status" className="mt-4">
              {playError && (
                <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {playError}
                </p>
              )}
              {playResult && (
                <div className="rounded-xl border border-line bg-ink/60 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`badge ${statusClass(playResult.status)}`}>
                      HTTP {playResult.status}
                    </span>
                    <span className="text-xs text-slate-400">{playResult.ms} ms</span>
                    <span className="font-mono text-xs text-slate-500">/api/gw/{playSlug}</span>
                  </div>
                  {playResult.headers.length > 0 && (
                    <ul className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
                      {playResult.headers.map(([name, value]) => (
                        <li key={name} className="truncate font-mono">
                          {name}: <span className="text-slate-200">{value}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-ink/80 p-2 text-xs text-slate-200">
                    {playResult.body}
                  </pre>
                </div>
              )}
            </div>
          </section>

          <section className="mt-5 card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Request gần đây</h2>
              <p className="text-xs text-slate-500">Log cập nhật mỗi 5 giây · tối đa 20 dòng</p>
            </div>
            {metrics && metrics.recent.length > 0 ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="pb-2 pr-3 font-medium">Thời gian</th>
                      <th scope="col" className="pb-2 pr-3 font-medium">Request</th>
                      <th scope="col" className="pb-2 pr-3 font-medium">Status</th>
                      <th scope="col" className="pb-2 pr-3 font-medium">Latency</th>
                      <th scope="col" className="pb-2 pr-3 font-medium">Bucket còn</th>
                      <th scope="col" className="pb-2 font-medium">Lỗi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {metrics.recent.map((log) => (
                      <tr key={log.id}>
                        <td className="py-2 pr-3 font-mono text-xs text-slate-400">{timeOf(log.createdAt)}</td>
                        <td className="py-2 pr-3">
                          <span className="font-mono text-xs text-slate-300">
                            {log.method} {log.path}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`badge ${statusClass(log.status)}`}>{log.status}</span>
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-slate-300">{log.latencyMs} ms</td>
                        <td className="py-2 pr-3 tabular-nums text-slate-400">
                          {log.bucketRemaining ?? '—'}
                        </td>
                        <td className="py-2 font-mono text-xs text-slate-400">{log.error ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">
                Chưa có request nào. Dùng playground hoặc curl để tạo log đầu tiên.
              </p>
            )}
          </section>
        </>
      )}

      <footer className="mt-10 border-t border-line pt-6 text-xs text-slate-500">
        <p>
          HTK 0396241674 · Token bucket trong bộ nhớ, quota cộng dồn theo lô. Production nên đặt bucket
          và quota trong Redis/Postgres dùng chung để giới hạn chính xác trên mọi instance.
        </p>
      </footer>
    </main>
  );
}

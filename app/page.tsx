import Link from 'next/link';
import { getUser } from '@/lib/auth';
import { DEMO_API_KEY, DEMO_EMAIL, DEMO_PASSWORD } from '@/lib/demo';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    title: 'API key băm SHA-256',
    body: 'Secret chỉ trả về một lần khi tạo. Server lưu hash, cache theo TTL 3 giây và thu hồi có hiệu lực ngay trên instance nhận request.',
  },
  {
    title: 'Token bucket theo key + endpoint',
    body: 'Mỗi cặp key/endpoint có bucket riêng: capacity cho burst, refill mỗi giây cho tốc độ bền. Từ chối không tiêu token nên client backoff sẽ hồi ngay.',
  },
  {
    title: 'Hạn mức theo tháng',
    body: 'Quota tháng UTC cộng dồn theo key. Chạm hạn trả 429 quota_exceeded kèm x-quota-remaining, không đụng tới bucket.',
  },
  {
    title: 'Log bất đồng bộ',
    body: 'Request ghi vào buffer trong bộ nhớ, flush theo lô 500 dòng. Đường nóng không chờ database nên throughput không phụ thuộc tốc độ ghi log.',
  },
  {
    title: 'Dashboard 15 phút',
    body: 'Throughput phút gần nhất, error rate, p50/p95, biểu đồ 15 phút, quota từng key và 20 request gần nhất với HTTP code, latency, bucket còn lại.',
  },
  {
    title: 'Upstream an toàn',
    body: 'Live upstream bắt buộc HTTPS, chặn localhost và dải IP nội bộ, timeout theo endpoint và không chuyển tiếp Authorization/Cookie của client.',
  },
];

export default async function HomePage() {
  const user = await getUser();

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-20 pt-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-lg font-black text-accent">
            H
          </span>
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-200">HTK Gateway</p>
            <p className="text-xs text-slate-500">API control plane</p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          {user ? (
            <Link className="btn-ghost" href="/workspace">
              Mở workspace
            </Link>
          ) : (
            <>
              <Link className="btn-ghost" href="/register">
                Đăng ký
              </Link>
              <Link className="btn-primary" href="/login">
                Đăng nhập
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="mt-16 max-w-3xl">
        <span className="badge border-accent/40 text-accent">
          Next.js · PGlite · Token bucket · Async log
        </span>
        <h1 className="mt-5 text-4xl font-semibold leading-tight sm:text-5xl">
          Đặt cửa cho API,
          <span className="text-accent"> thấy rõ từng request đi qua</span>.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-slate-300 sm:text-lg">
          Cấp key cho từng client, giới hạn burst và tốc độ bền bằng token bucket, chặn theo hạn mức
          tháng, rồi đọc throughput, error rate và p95 trên cùng một dashboard. Log ghi theo lô nên
          không nằm trên đường nóng.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link className="btn-primary" href={user ? '/workspace' : '/login'}>
            {user ? 'Mở workspace' : 'Thử bản demo'}
          </Link>
          <Link className="btn-ghost" href="/register">
            Tạo tài khoản
          </Link>
        </div>

        <div className="mt-8 rounded-xl border border-line bg-panel/50 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-200">Tài khoản demo</p>
          <p className="mt-1 font-mono text-xs text-accent">
            {DEMO_EMAIL} · {DEMO_PASSWORD}
          </p>
          <p className="mt-1 break-all font-mono text-xs text-slate-300">{DEMO_API_KEY}</p>
          <p className="mt-1 text-xs text-slate-400">
            3 endpoint sandbox, 96 log mẫu trong 15 phút gần nhất và một key đã thu hồi.
          </p>
        </div>
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tính năng">
        {FEATURES.map((feature) => (
          <article key={feature.title} className="card">
            <h2 className="text-base font-semibold text-slate-100">{feature.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="mt-14 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <div className="card">
          <h2 className="text-lg font-semibold">Một request đi qua gateway thế nào?</h2>
          <ol className="mt-4 space-y-3 text-sm text-slate-300">
            {[
              'Client gọi /api/gw/:slug kèm Authorization: Bearer <key>.',
              'Gateway tra key theo SHA-256 (cache 3 giây), kiểm tra endpoint thuộc cùng tài khoản.',
              'Bucket của cặp key + endpoint được nạp lười; hết token trả 429 kèm Retry-After.',
              'Quota tháng được trừ trong bộ nhớ rồi cộng dồn vào database theo lô.',
              'Upstream sandbox trả ngay, upstream live được forward với timeout và chặn SSRF.',
              'Log xếp vào buffer, flush theo lô; dashboard đọc log đã flush để vẽ traffic.',
            ].map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="card">
          <h2 className="text-lg font-semibold">Thử bằng curl</h2>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-ink/70 p-3 text-xs leading-relaxed text-slate-300">
            <code>{`curl -i https://htk-api-gateway.vercel.app/api/gw/orders \\
  -H "Authorization: Bearer ${DEMO_API_KEY}"`}</code>
          </pre>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Endpoint <span className="text-slate-200">orders</span> echo lại request.{' '}
            <span className="text-slate-200">catalog</span> trả sau 35 ms.{' '}
            <span className="text-slate-200">reports</span> luôn 503 để error rate tăng thật.
          </p>
          <p className="mt-4 text-xs leading-relaxed text-slate-500">
            Trạng thái bucket nằm trong bộ nhớ từng instance. Trên serverless nhiều instance, giới hạn
            hiệu dụng là tổng theo instance; production nên đặt bucket trong Redis dùng chung.
          </p>
        </div>
      </section>

      <footer className="mt-16 border-t border-line pt-6 text-sm text-slate-500">
        <p>
          Tác giả <span className="text-slate-300">HTK 0396241674</span> · Dự án 09/10 trong portfolio
          full-stack.
        </p>
      </footer>
    </main>
  );
}

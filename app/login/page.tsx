import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getUser()) redirect('/workspace');
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-12 sm:px-6">
      <div className="grid w-full gap-10 lg:grid-cols-[1fr_auto] lg:items-center">
        <section>
          <Link className="text-sm text-slate-400 hover:text-slate-200" href="/">
            ← Về trang chủ
          </Link>
          <h2 className="mt-6 text-3xl font-semibold leading-tight">
            Đăng nhập để cấp key và xem traffic đi qua gateway.
          </h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
            Key, endpoint, quota và log tách theo tài khoản. Dashboard đọc log bất đồng bộ nên request
            không phải chờ ghi database.
          </p>
        </section>
        <AuthForm mode="login" />
      </div>
    </main>
  );
}

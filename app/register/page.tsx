import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  if (await getUser()) redirect('/workspace');
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-12 sm:px-6">
      <div className="grid w-full gap-10 lg:grid-cols-[1fr_auto] lg:items-center">
        <section>
          <Link className="text-sm text-slate-400 hover:text-slate-200" href="/">
            ← Về trang chủ
          </Link>
          <h2 className="mt-6 text-3xl font-semibold leading-tight">
            Tạo tài khoản, cấp API key đầu tiên trong một phút.
          </h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
            Bạn tự đặt capacity, tốc độ nạp token và hạn mức tháng. Endpoint sandbox cho kết quả tất
            định: echo, chậm 35 ms hoặc lỗi 503.
          </p>
        </section>
        <AuthForm mode="register" />
      </div>
    </main>
  );
}

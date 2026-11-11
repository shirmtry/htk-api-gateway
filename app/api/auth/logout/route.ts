import { destroySession } from '@/lib/auth';
import { route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async () => {
  await destroySession();
  return Response.json({ ok: true });
});

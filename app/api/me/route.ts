import { getUser } from '@/lib/auth';
import { route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const user = await getUser();
  return Response.json({ user });
});

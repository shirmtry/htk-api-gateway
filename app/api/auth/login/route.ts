import { z } from 'zod';
import { createSession } from '@/lib/auth';
import { getDb, saveState } from '@/lib/db';
import { clientIp, HttpError, readJson, route } from '@/lib/http';
import { enforceLimit } from '@/lib/limits';
import { verifyPassword } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const POST = route(async (req) => {
  const ip = clientIp(req);
  await enforceLimit(`login-ip:${ip}`, 20, 60);
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'Email hoặc mật khẩu không hợp lệ.');
  await enforceLimit(`login-email:${parsed.data.email}`, 10, 300);

  const db = await getDb();
  const result = await db.query<{ id: string; email: string; name: string; password_hash: string }>(
    'select id, email, name, password_hash from users where email = $1',
    [parsed.data.email],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng.');
  }
  await createSession(user.id);
  await saveState();
  return Response.json({ user: { id: user.id, email: user.email, name: user.name } });
});

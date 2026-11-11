import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createSession } from '@/lib/auth';
import { getDb, saveState } from '@/lib/db';
import { clientIp, HttpError, readJson, route } from '@/lib/http';
import { enforceLimit } from '@/lib/limits';
import { hashPassword } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200),
});

export const POST = route(async (req) => {
  const ip = clientIp(req);
  await enforceLimit(`register:${ip}`, 10, 3600);
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_input', 'Kiểm tra lại email, tên và mật khẩu tối thiểu 8 ký tự.');
  }

  const db = await getDb();
  const exists = await db.query('select 1 from users where email = $1', [parsed.data.email]);
  if (exists.rows.length > 0) throw new HttpError(409, 'email_taken', 'Email này đã được đăng ký.');

  const id = `u-${randomUUID().slice(0, 8)}`;
  await db.query('insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)', [
    id,
    parsed.data.email,
    parsed.data.name,
    await hashPassword(parsed.data.password),
  ]);
  await saveState();
  await createSession(id);
  return Response.json({ user: { id, email: parsed.data.email, name: parsed.data.name } });
});

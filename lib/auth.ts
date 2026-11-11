import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from './db';

export const SESSION_COOKIE = 'htk_gateway_session';
const SESSION_DAYS = 7;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const id = randomUUID();
  await db.query(
    "insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '7 days')",
    [id, userId],
  );
  await db.query('delete from sessions where expires_at < now()');
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) {
    const db = await getDb();
    await db.query('delete from sessions where id = $1', [id]);
  }
  jar.delete(SESSION_COOKIE);
}

export async function getUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const db = await getDb();
  const result = await db.query<SessionUser>(
    `select u.id, u.email, u.name
     from sessions s join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now()`,
    [id],
  );
  return result.rows[0] ?? null;
}

import { getUser, type SessionUser } from './auth';
import { HttpError } from './http';

export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) throw new HttpError(401, 'unauthorized', 'Cần đăng nhập để tiếp tục.');
  return user;
}

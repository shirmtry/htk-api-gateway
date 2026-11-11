import { z } from 'zod';
import { createApiKey, listApiKeys } from '@/lib/data';
import { requireUser } from '@/lib/guard';
import { HttpError, readJson, route } from '@/lib/http';
import { enforceLimit } from '@/lib/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  capacity: z.number().int().min(1).max(10_000),
  refillPerSec: z.number().int().min(1).max(5_000),
  quotaMonthly: z.number().int().min(100).max(100_000_000),
});

export const GET = route(async () => {
  const user = await requireUser();
  return Response.json({ keys: await listApiKeys(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  await enforceLimit(`keys-create:${user.id}`, 30, 60);
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_input',
      'Kiểm tra lại tên, capacity, refill và quota. Capacity 1–10.000, refill 1–5.000/giây.',
    );
  }
  const created = await createApiKey(user.id, parsed.data);
  return Response.json(created, { status: 201 });
});

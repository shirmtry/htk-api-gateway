import { z } from 'zod';
import { createEndpoint, listEndpoints } from '@/lib/data';
import { requireUser } from '@/lib/guard';
import { HttpError, readJson, route } from '@/lib/http';
import { enforceLimit } from '@/lib/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  slug: z.string().trim().min(2).max(32),
  name: z.string().trim().min(2).max(80),
  upstreamUrl: z.string().trim().min(1).max(500),
  timeoutMs: z.number().int().min(100).max(10_000),
});

export const GET = route(async () => {
  const user = await requireUser();
  return Response.json({ endpoints: await listEndpoints(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  await enforceLimit(`endpoints-create:${user.id}`, 30, 60);
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_input', 'Kiểm tra slug, tên, upstream và timeout (100–10.000 ms).');
  }
  const endpoint = await createEndpoint(user.id, parsed.data);
  return Response.json({ endpoint }, { status: 201 });
});

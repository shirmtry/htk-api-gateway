import { z } from 'zod';
import { deleteEndpoint, updateEndpoint } from '@/lib/data';
import { requireUser } from '@/lib/guard';
import { HttpError, readJson, route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    upstreamUrl: z.string().trim().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(100).max(10_000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Cần ít nhất một trường để cập nhật.' });

export const PATCH = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_input', 'Kiểm tra lại tên, upstream, timeout hoặc trạng thái.');
  }
  const endpoint = await updateEndpoint(user.id, id, parsed.data);
  return Response.json({ endpoint });
});

export const DELETE = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await deleteEndpoint(user.id, id);
  return Response.json({ ok: true });
});

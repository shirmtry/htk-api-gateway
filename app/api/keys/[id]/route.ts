import { revokeApiKey } from '@/lib/data';
import { requireUser } from '@/lib/guard';
import { route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const key = await revokeApiKey(user.id, id);
  return Response.json({ key });
});

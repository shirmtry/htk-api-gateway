import { getMetrics } from '@/lib/data';
import { flushGatewayLogs } from '@/lib/gateway';
import { requireUser } from '@/lib/guard';
import { route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const user = await requireUser();
  await flushGatewayLogs();
  return Response.json(await getMetrics(user.id));
});

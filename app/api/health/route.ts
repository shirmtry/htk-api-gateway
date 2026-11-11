import { getDb, usingBlob } from '@/lib/db';
import { droppedLogCount } from '@/lib/gateway';
import { route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const db = await getDb();
  const [keys, endpoints, logs] = await Promise.all([
    db.query<{ n: number }>('select count(*)::int as n from api_keys'),
    db.query<{ n: number }>('select count(*)::int as n from endpoints'),
    db.query<{ n: number }>('select count(*)::int as n from gateway_logs'),
  ]);
  return Response.json({
    ok: true,
    service: 'htk-api-gateway',
    db: 'ok',
    persistence: usingBlob() ? 'vercel-blob' : 'pglite-file',
    keys: Number(keys.rows[0]?.n ?? 0),
    endpoints: Number(endpoints.rows[0]?.n ?? 0),
    logs: Number(logs.rows[0]?.n ?? 0),
    droppedLogs: droppedLogCount(),
    ts: new Date().toISOString(),
  });
});

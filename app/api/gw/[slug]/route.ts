import { after } from 'next/server';
import { flushGatewayLogsIfIdle, handleGatewayRequest } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const response = await handleGatewayRequest(req, slug);
  after(() => flushGatewayLogsIfIdle());
  return response;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

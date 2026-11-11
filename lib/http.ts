import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getDb, saveState } from './db';

export function logEvent(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: fields.level ?? 'info',
      event,
      ...fields,
    }),
  );
}

export function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers?: HeadersInit,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

let logCounter = 0;

export async function recordRequest(req: Request, status: number, durationMs: number, requestId: string) {
  const url = new URL(req.url);
  logEvent('request', {
    requestId,
    method: req.method,
    path: url.pathname,
    status,
    durationMs,
  });
  try {
    const db = await getDb();
    await db.query(
      'insert into request_logs (id, method, path, status, duration_ms) values ($1,$2,$3,$4,$5)',
      [randomUUID(), req.method, url.pathname, status, Math.round(durationMs)],
    );
    logCounter += 1;
    if (logCounter % 15 === 0) void saveState().catch(() => undefined);
  } catch (error) {
    logEvent('log_error', { level: 'warn', message: String(error) });
  }
}

export function route<Ctx = unknown>(handler: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const started = performance.now();
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await handler(req, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        logEvent('handled_error', {
          level: 'warn',
          requestId,
          code: error.code,
          status: error.status,
          message: error.message,
        });
        response = fail(error.status, error.code, error.message, error.headers);
      } else {
        logEvent('unhandled_error', {
          level: 'error',
          requestId,
          message: error instanceof Error ? error.message : String(error),
        });
        response = fail(500, 'internal_error', 'Đã có lỗi phía server. Vui lòng thử lại.');
      }
    }
    response.headers.set('x-request-id', requestId);
    await recordRequest(req, response.status, performance.now() - started, requestId);
    return response;
  };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'local';
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body phải là JSON hợp lệ.');
  }
}

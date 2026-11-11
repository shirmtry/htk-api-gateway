import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { get, head, put } from '@vercel/blob';
import { MIGRATIONS } from './migrations';
import { seedDemo } from './seed';

const STATE_PATH = 'state/api-gateway.json';

// rate_limits is intentionally ephemeral: it is per-instance and cheap to rebuild.
const DATA_TABLES = [
  'users',
  'sessions',
  'api_keys',
  'endpoints',
  'gateway_logs',
  'request_logs',
];

type Globals = typeof globalThis & {
  __htkDb?: Promise<PGlite>;
  __htkSave?: Promise<void>;
  __htkEtag?: string | null;
  __htkSyncAt?: number;
  __htkSyncing?: Promise<void> | null;
};

const globals = globalThis as Globals;

export function usingBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.VERCEL);
}

async function migrate(db: PGlite) {
  await db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const applied = await db.query<{ version: number }>('select version from schema_migrations');
  const versions = new Set(applied.rows.map((r) => Number(r.version)));
  for (const migration of MIGRATIONS) {
    if (versions.has(migration.version)) continue;
    await db.exec(migration.sql);
    await db.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [
      migration.version,
    ]);
  }
}

type StateFile = {
  version: number;
  savedAt: string;
  tables: Record<string, unknown[]>;
};

async function downloadState(): Promise<StateFile | null> {
  try {
    const result = await get(STATE_PATH, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN,
      useCache: false,
    });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as StateFile;
  } catch {
    return null;
  }
}

async function insertRows(db: PGlite, table: string, rows: unknown[]) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await db.query(
    `insert into "${table}" select * from json_populate_recordset(null::"${table}", $1::json) on conflict do nothing`,
    [JSON.stringify(rows)],
  );
}

async function restoreState(db: PGlite, state: StateFile) {
  for (const table of DATA_TABLES) {
    await insertRows(db, table, state.tables[table]);
  }
}

async function replaceState(db: PGlite, state: StateFile) {
  await db.exec('begin');
  try {
    for (const table of [...DATA_TABLES].reverse()) {
      await db.exec(`delete from "${table}"`);
    }
    for (const table of DATA_TABLES) {
      await insertRows(db, table, state.tables[table]);
    }
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function maybeSyncFromBlob(db: PGlite) {
  if (!usingBlob()) return;
  const now = Date.now();
  if (now - (globals.__htkSyncAt ?? 0) < 700) return;
  if (globals.__htkSyncing) {
    await globals.__htkSyncing;
    return;
  }
  globals.__htkSyncAt = now;
  globals.__htkSyncing = (async () => {
    try {
      const meta = await head(STATE_PATH, { token: process.env.BLOB_READ_WRITE_TOKEN });
      if (!meta || meta.etag === globals.__htkEtag) return;
      const state = await downloadState();
      if (!state) return;
      await replaceState(db, state);
      globals.__htkEtag = meta.etag;
    } catch {
      // A stale instance is worse than a missed sync; keep serving local state.
    } finally {
      globals.__htkSyncing = null;
    }
  })();
  await globals.__htkSyncing;
}

export async function persistNow(db: PGlite) {
  if (!usingBlob()) return;
  const tables: Record<string, unknown[]> = {};
  for (const table of DATA_TABLES) {
    const result = await db.query<{ data: string }>(
      `select coalesce(json_agg(t), '[]'::json)::text as data from (select * from "${table}") t`,
    );
    tables[table] = JSON.parse(result.rows[0]?.data ?? '[]') as unknown[];
  }
  await put(STATE_PATH, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tables }), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
  try {
    const meta = await head(STATE_PATH, { token: process.env.BLOB_READ_WRITE_TOKEN });
    globals.__htkEtag = meta?.etag ?? null;
    globals.__htkSyncAt = Date.now();
  } catch {
    globals.__htkEtag = null;
  }
}

async function init(): Promise<PGlite> {
  if (!usingBlob()) {
    const dataDir = process.env.PGLITE_DIR || './.data/pg';
    mkdirSync(dataDir, { recursive: true });
    const db = new PGlite(dataDir);
    await db.waitReady;
    await migrate(db);
    await seedDemo(db);
    return db;
  }

  const state = await downloadState();
  const db = new PGlite();
  await db.waitReady;
  await migrate(db);
  if (state) {
    await restoreState(db, state);
    try {
      const meta = await head(STATE_PATH, { token: process.env.BLOB_READ_WRITE_TOKEN });
      globals.__htkEtag = meta?.etag ?? null;
      globals.__htkSyncAt = Date.now();
    } catch {
      globals.__htkEtag = null;
    }
  } else {
    await seedDemo(db);
    await persistNow(db);
  }
  return db;
}

export async function getDb(): Promise<PGlite> {
  if (!globals.__htkDb) {
    globals.__htkDb = init().catch((error) => {
      globals.__htkDb = undefined;
      throw error;
    });
  }
  const db = await globals.__htkDb;
  await maybeSyncFromBlob(db);
  return db;
}

export async function saveState(): Promise<void> {
  if (!usingBlob()) return;
  const previous = (globals.__htkSave ?? Promise.resolve()).catch(() => undefined);
  globals.__htkSave = previous.then(async () => {
    const db = await getDb();
    await persistNow(db);
  });
  await globals.__htkSave;
}

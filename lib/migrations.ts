export type Migration = { version: number; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      create table if not exists users (
        id text primary key,
        email text not null unique,
        name text not null,
        password_hash text not null,
        created_at timestamptz not null default now()
      );

      create table if not exists sessions (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      );
      create index if not exists sessions_user on sessions (user_id);

      create table if not exists api_keys (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        name text not null,
        key_prefix text not null,
        key_hash text not null unique,
        capacity integer not null check (capacity > 0),
        refill_per_sec integer not null check (refill_per_sec > 0),
        quota_monthly integer not null check (quota_monthly > 0),
        used_this_month integer not null default 0,
        period text not null,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz not null default now()
      );
      create index if not exists api_keys_user on api_keys (user_id);

      create table if not exists endpoints (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        slug text not null unique,
        name text not null,
        upstream_url text not null,
        timeout_ms integer not null default 3000 check (timeout_ms between 100 and 30000),
        enabled boolean not null default true,
        created_at timestamptz not null default now()
      );
      create index if not exists endpoints_user on endpoints (user_id);

      create table if not exists gateway_logs (
        id text primary key,
        user_id text not null,
        key_id text not null,
        endpoint_id text not null,
        endpoint_slug text not null,
        request_id text not null,
        method text not null,
        path text not null,
        status integer not null,
        upstream_status integer,
        latency_ms integer not null,
        bucket_remaining integer,
        upstream text not null,
        error text,
        created_at timestamptz not null default now()
      );
      create index if not exists gateway_logs_user_time on gateway_logs (user_id, created_at desc);
      create index if not exists gateway_logs_endpoint_time on gateway_logs (endpoint_id, created_at desc);

      create table if not exists request_logs (
        id text primary key,
        method text not null,
        path text not null,
        status integer not null,
        duration_ms integer not null,
        created_at timestamptz not null default now()
      );

      create table if not exists rate_limits (
        key text primary key,
        window_start bigint not null,
        count integer not null
      );
    `,
  },
];

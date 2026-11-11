export type BucketConfig = {
  capacity: number;
  refillPerSec: number;
};

export type BucketState = {
  tokens: number;
  updatedAt: number;
};

export type TokenResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  next: BucketState;
};

export function createBucket(config: BucketConfig, now = Date.now()): BucketState {
  return { tokens: config.capacity, updatedAt: now };
}

/**
 * Token bucket with lazy refill. A rejected request does not spend a token, so a
 * client that backs off recovers as soon as one token has accumulated.
 */
export function takeToken(
  state: BucketState,
  config: BucketConfig,
  now = Date.now(),
  cost = 1,
): TokenResult {
  const elapsedMs = Math.max(0, now - state.updatedAt);
  const refilled = Math.min(config.capacity, state.tokens + (elapsedMs / 1000) * config.refillPerSec);
  const next: BucketState = { tokens: refilled, updatedAt: now };

  if (refilled >= cost) {
    next.tokens = refilled - cost;
    return { allowed: true, remaining: Math.floor(next.tokens), retryAfterMs: 0, next };
  }

  const deficit = cost - refilled;
  const retryAfterMs = Math.max(1, Math.ceil((deficit / config.refillPerSec) * 1000));
  return { allowed: false, remaining: 0, retryAfterMs, next };
}

export type QuotaState = {
  period: string;
  used: number;
};

export type QuotaResult = {
  allowed: boolean;
  state: QuotaState;
  remaining: number;
  rolledOver: boolean;
};

/** Monthly quota period, UTC, formatted YYYY-MM. */
export function periodOf(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function createQuota(period = periodOf(), used = 0): QuotaState {
  return { period, used };
}

export function consumeQuota(state: QuotaState, limit: number, now = new Date()): QuotaResult {
  const period = periodOf(now);
  const rolledOver = state.period !== period;
  const used = rolledOver ? 0 : state.used;
  if (used >= limit) {
    return { allowed: false, state: { period, used }, remaining: 0, rolledOver };
  }
  return {
    allowed: true,
    state: { period, used: used + 1 },
    remaining: Math.max(0, limit - used - 1),
    rolledOver,
  };
}

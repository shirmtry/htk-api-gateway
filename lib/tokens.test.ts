import { describe, expect, it } from 'vitest';
import {
  consumeQuota,
  createBucket,
  createQuota,
  periodOf,
  takeToken,
} from './tokens';

const config = { capacity: 5, refillPerSec: 2 };

describe('token bucket', () => {
  it('bắt đầu đầy và cho phép đúng capacity request liên tiếp', () => {
    let state = createBucket(config, 0);
    for (let i = 0; i < 5; i += 1) {
      const result = takeToken(state, config, 0);
      expect(result.allowed).toBe(true);
      state = result.next;
    }
    const blocked = takeToken(state, config, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('từ chối kèm retryAfterMs đủ để có một token', () => {
    const state = { tokens: 0, updatedAt: 1000 };
    const result = takeToken(state, config, 1000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(500);
  });

  it('nạp lại theo thời gian trôi qua', () => {
    let state = createBucket(config, 0);
    for (let i = 0; i < 5; i += 1) state = takeToken(state, config, 0).next;
    const early = takeToken(state, config, 250);
    expect(early.allowed).toBe(false);
    const later = takeToken(state, config, 500);
    expect(later.allowed).toBe(true);
    expect(later.next.tokens).toBeCloseTo(0, 5);
  });

  it('không nạp vượt capacity', () => {
    const state = { tokens: 1, updatedAt: 0 };
    const result = takeToken(state, config, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.next.tokens).toBe(config.capacity - 1);
  });

  it('request bị từ chối không tiêu token', () => {
    const state = { tokens: 0, updatedAt: 0 };
    const rejected = takeToken(state, config, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.next.tokens).toBe(0);
  });
});

describe('hạn mức tháng', () => {
  it('đếm theo tháng UTC và chặn khi chạm hạn', () => {
    const now = new Date('2026-11-11T10:00:00Z');
    let state = createQuota(periodOf(now), 0);
    for (let i = 0; i < 2; i += 1) {
      const result = consumeQuota(state, 2, now);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    const blocked = consumeQuota(state, 2, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('sang tháng mới thì reset về 0', () => {
    const oldState = { period: '2026-10', used: 100 };
    const result = consumeQuota(oldState, 100, new Date('2026-11-01T00:30:00Z'));
    expect(result.allowed).toBe(true);
    expect(result.rolledOver).toBe(true);
    expect(result.state).toEqual({ period: '2026-11', used: 1 });
    expect(result.remaining).toBe(99);
  });

  it('giữ nguyên period khi còn hạn', () => {
    const state = { period: '2026-11', used: 4 };
    const result = consumeQuota(state, 10, new Date('2026-11-30T23:59:59Z'));
    expect(result.allowed).toBe(true);
    expect(result.rolledOver).toBe(false);
    expect(result.remaining).toBe(5);
  });
});

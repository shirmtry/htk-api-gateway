import { describe, expect, it } from 'vitest';
import { checkUpstreamUrl } from './gateway';
import { generateApiKey, hashApiKey, keyPrefix, parseBearer } from './keys';

describe('API key', () => {
  it('sinh key đúng định dạng và không trùng nhau', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first).toMatch(/^htk_live_[A-Za-z0-9_-]{20,}$/);
    expect(first).not.toBe(second);
  });

  it('hash SHA-256 ổn định và không thể đảo ngược', () => {
    const secret = 'htk_live_demo_orders_7f3a91c2';
    expect(hashApiKey(secret)).toBe(hashApiKey(secret));
    expect(hashApiKey(secret)).toHaveLength(64);
    expect(hashApiKey(secret)).not.toContain(secret);
    expect(hashApiKey(`${secret}x`)).not.toBe(hashApiKey(secret));
  });

  it('prefix chỉ lộ 13 ký tự đầu', () => {
    const secret = generateApiKey();
    expect(keyPrefix(secret)).toHaveLength(13);
    expect(secret.startsWith(keyPrefix(secret))).toBe(true);
    expect(secret).not.toBe(keyPrefix(secret));
  });

  it('chỉ chấp nhận header Bearer hợp lệ', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
    expect(parseBearer('bearer abc123')).toBe('abc123');
    expect(parseBearer('Token abc123')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe('chặn SSRF cho upstream live', () => {
  it('cho phép HTTPS công khai', () => {
    const result = checkUpstreamUrl('https://api.example.com/v1/orders');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe('api.example.com');
  });

  it('chặn HTTP thường và URL có thông tin đăng nhập', () => {
    expect(checkUpstreamUrl('http://api.example.com').ok).toBe(false);
    expect(checkUpstreamUrl('https://user:pass@api.example.com').ok).toBe(false);
    expect(checkUpstreamUrl('not a url').ok).toBe(false);
  });

  it('chặn localhost và các dải IP nội bộ', () => {
    for (const url of [
      'https://localhost:8080',
      'https://api.localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.10',
      'https://172.20.0.1',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]:9000',
      'https://0.0.0.0',
      'https://metadata.internal',
    ]) {
      expect(checkUpstreamUrl(url).ok, url).toBe(false);
    }
  });

  it('không chặn nhầm 172.32 hoặc host công khai', () => {
    expect(checkUpstreamUrl('https://172.32.0.1').ok).toBe(true);
    expect(checkUpstreamUrl('https://fcbarcelona.com').ok).toBe(true);
  });
});

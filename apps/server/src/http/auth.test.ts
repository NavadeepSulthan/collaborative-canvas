import { describe, expect, it } from 'vitest';
import { TokenBucket } from './token-bucket.js';
import { TokenService } from './token-service.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect([1, 2, 3, 4].map(() => bucket.tryRemove())).toEqual([true, true, true, false]);
    now = 1000;
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('never exceeds capacity after long idle periods', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 10, () => now);
    now = 60_000;
    expect([1, 2, 3].map(() => bucket.tryRemove())).toEqual([true, true, false]);
  });
});

describe('TokenService', () => {
  const secret = 'x'.repeat(32);

  it('round-trips identity, tenant and role', async () => {
    const service = new TokenService(secret);
    const { token, user } = await service.issue({ tenantId: 'acme', name: 'Ada', role: 'viewer' });
    await expect(service.verify(token)).resolves.toEqual(user);
  });

  it('rejects tokens signed with a different secret', async () => {
    const { token } = await new TokenService('y'.repeat(32)).issue({
      tenantId: 'acme',
      name: 'Eve',
      role: 'editor',
    });
    await expect(new TokenService(secret).verify(token)).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const service = new TokenService(secret, -10);
    const { token } = await service.issue({ tenantId: 'acme', name: 'Ada', role: 'editor' });
    await expect(service.verify(token)).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { devTokenRequestSchema } from './auth.js';
import { roomKey, slugSchema } from './ids.js';

describe('slugSchema', () => {
  it.each(['a', 'acme', 'team-42', 'a'.repeat(64)])('accepts %s', (value) => {
    expect(slugSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', '-a', 'a-', 'Acme', 'a_b', '../etc', 'a'.repeat(65), 'a b'])(
    'rejects %j',
    (value) => {
      expect(slugSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('devTokenRequestSchema', () => {
  it('defaults role to editor and trims the name', () => {
    const parsed = devTokenRequestSchema.parse({ tenantId: 'acme', displayName: '  Ada  ' });
    expect(parsed).toEqual({ tenantId: 'acme', displayName: 'Ada', role: 'editor' });
  });

  it('rejects unknown roles', () => {
    const result = devTokenRequestSchema.safeParse({
      tenantId: 'acme',
      displayName: 'Ada',
      role: 'admin',
    });
    expect(result.success).toBe(false);
  });
});

describe('roomKey', () => {
  it('namespaces rooms by tenant', () => {
    expect(roomKey('acme', 'design')).not.toBe(roomKey('globex', 'design'));
  });
});

import { randomUUID } from 'node:crypto';
import { authenticatedUserSchema, type AuthenticatedUser, type Role } from '@canvas/shared';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'collab-canvas';
const AUDIENCE = 'collab-canvas';

export class InvalidTokenError extends Error {}

/** Issues and verifies short-lived HS256 access tokens that carry tenant, identity and role. */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = 60 * 60,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(input: { tenantId: string; name: string; role: Role }): Promise<{
    token: string;
    expiresAt: Date;
    user: AuthenticatedUser;
  }> {
    const user: AuthenticatedUser = { id: randomUUID(), ...input };
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const token = await new SignJWT({ tenant: user.tenantId, name: user.name, role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt, user };
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      return authenticatedUserSchema.parse({
        id: payload.sub,
        tenantId: payload.tenant,
        name: payload.name,
        role: payload.role,
      });
    } catch (error) {
      throw new InvalidTokenError((error as Error).message);
    }
  }
}

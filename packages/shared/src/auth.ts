import { z } from 'zod';
import { slugSchema } from './ids.js';

export const ROLES = ['editor', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const displayNameSchema = z.string().trim().min(1).max(40);

export const devTokenRequestSchema = z.object({
  tenantId: slugSchema,
  displayName: displayNameSchema,
  role: roleSchema.default('editor'),
});
export type DevTokenRequest = z.input<typeof devTokenRequestSchema>;

export const authenticatedUserSchema = z.object({
  id: z.string().min(1),
  tenantId: slugSchema,
  name: displayNameSchema,
  role: roleSchema,
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const devTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  user: authenticatedUserSchema,
});
export type DevTokenResponse = z.infer<typeof devTokenResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

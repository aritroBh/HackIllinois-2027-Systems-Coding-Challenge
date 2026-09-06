/**
 * Request shapes for the identity endpoints.
 */
import { z } from 'zod';
import { objectId } from './common';

export const issueClaimCodeSchema = z.object({
  body: z
    .object({
      accountId: objectId('Invalid account id').optional(),
      email: z.string().email().optional(),
      ttlHours: z.number().int().min(1).max(336).optional(),
    })
    .refine((b) => !!b.accountId || !!b.email, { message: 'accountId or email is required' }),
});

export const issueClaimCodesBulkSchema = z.object({
  body: z.object({
    kind: z.enum(['VOLUNTEER', 'HACKER']).optional(),
    ttlHours: z.number().int().min(1).max(336).optional(),
  }),
});

export const claimSchema = z.object({
  body: z.object({
    // 10 Crockford characters, tolerant of dashes/spaces the user may type.
    code: z.string().trim().min(10).max(16),
  }),
});

export const magicLinkSchema = z.object({
  body: z.object({ email: z.string().trim().email().max(254) }),
});

export const magicRedeemSchema = z.object({
  body: z.object({ token: z.string().min(16).max(256) }),
});

export const adonixSchema = z.object({
  body: z.object({ token: z.string().min(16).max(4096) }),
});

export const devLoginSchema = z.object({
  body: z.object({ accountId: objectId('Invalid account id') }),
});

export const revokeSchema = z.object({
  params: z.object({ id: objectId('Invalid account id') }),
});

export const setRoleSchema = z.object({
  params: z.object({ id: objectId('Invalid account id') }),
  body: z.object({ role: z.enum(['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN']) }),
});

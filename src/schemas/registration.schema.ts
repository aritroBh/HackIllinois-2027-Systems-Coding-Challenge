import { z } from 'zod';

export const reserveShiftSchema = z.object({
  body: z.object({
    shiftId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
  }),
  headers: z.object({
    'idempotency-key': z.string().min(8, 'idempotency-key header must be at least 8 characters').optional(),
  }).passthrough(),
});

export const cancelRegistrationSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Registration ObjectId'),
  }),
});

export const listRegistrationsQuerySchema = z.object({
  query: z.object({
    shiftId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    status: z.enum(['CONFIRMED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED']).optional(),
  }),
});

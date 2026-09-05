import { z } from 'zod';

export const createSwapRequestSchema = z.object({
  body: z.object({
    proposerVolunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
    proposerShiftId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
    targetVolunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId').optional(),
    targetShiftId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
    desiredShiftIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
  }),
});

export const acceptSwapSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Swap ObjectId'),
  }),
  body: z.object({
    targetVolunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
  }),
});

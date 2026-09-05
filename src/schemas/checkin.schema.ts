import { z } from 'zod';

export const generateQrTokenSchema = z.object({
  body: z.object({
    shiftId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
  }),
});

export const verifyCheckInSchema = z.object({
  body: z.object({
    token: z.string().min(20, 'Malformed token string'),
    scannerId: z.string().default('DESK_SCANNER_MAIN'),
  }),
});

export const checkOutSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid CheckIn ObjectId'),
  }),
});

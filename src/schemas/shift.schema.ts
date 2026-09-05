import { z } from 'zod';
import { ShiftCategory } from '../models/shift.model';

export const createShiftSchema = z.object({
  body: z.object({
    title: z.string().min(3, 'Title must be at least 3 characters long'),
    description: z.string().min(5, 'Description must be at least 5 characters long'),
    category: z.nativeEnum(ShiftCategory).default(ShiftCategory.LOGISTICS),
    location: z.string().min(2, 'Location is required'),
    startTime: z.string().datetime({ message: 'startTime must be a valid ISO 8601 string' }),
    endTime: z.string().datetime({ message: 'endTime must be a valid ISO 8601 string' }),
    capacity: z.number().int().positive('Capacity must be at least 1'),
    requiredSkills: z.array(z.string()).default([]),
    baseKarma: z.number().int().min(10).default(100),
    manualSurgeMultiplier: z.number().min(1.0).max(5.0).default(1.0),
  }).refine((data) => new Date(data.startTime) < new Date(data.endTime), {
    message: 'startTime must occur before endTime',
    path: ['endTime'],
  }),
});

export const updateShiftSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
  }),
  body: z.object({
    title: z.string().min(3).optional(),
    description: z.string().min(5).optional(),
    category: z.nativeEnum(ShiftCategory).optional(),
    location: z.string().min(2).optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    capacity: z.number().int().positive().optional(),
    requiredSkills: z.array(z.string()).optional(),
    baseKarma: z.number().int().min(10).optional(),
    manualSurgeMultiplier: z.number().min(1.0).max(5.0).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const getShiftParamsSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Shift ObjectId'),
  }),
});

export const listShiftsQuerySchema = z.object({
  query: z.object({
    category: z.nativeEnum(ShiftCategory).optional(),
    location: z.string().optional(),
    availableOnly: z.enum(['true', 'false']).optional(),
    surgeOnly: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
});

import { z } from 'zod';
import { VolunteerRole } from '../models/volunteer.model';

export const createVolunteerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    phone: z.string().optional(),
    role: z.nativeEnum(VolunteerRole).default(VolunteerRole.VOLUNTEER),
    certifications: z.array(z.string()).default([]),
  }),
});

export const getVolunteerParamsSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
  }),
});

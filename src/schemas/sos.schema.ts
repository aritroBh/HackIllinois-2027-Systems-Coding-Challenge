import { z } from 'zod';
import { SOSTicketCategory, SOSTicketUrgency, SOSTicketStatus } from '../models/sosTicket.model';

export const createSOSTicketSchema = z.object({
  body: z.object({
    hackerName: z.string().min(1, 'Hacker name is required'),
    tableLocation: z.string().min(1, 'Table location is required'),
    coordinates: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
    category: z.nativeEnum(SOSTicketCategory).default(SOSTicketCategory.LOGISTICS_SUPPLIES),
    description: z.string().min(3, 'Description must be at least 3 characters'),
    urgency: z.nativeEnum(SOSTicketUrgency).default(SOSTicketUrgency.MEDIUM),
    requiredSkill: z.string().optional(),
    karmaBounty: z.number().min(50).optional(),
  }),
});

export const dispatchSOSTicketSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Ticket ObjectId'),
  }),
});

export const resolveSOSTicketSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Ticket ObjectId'),
  }),
  body: z.object({
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId').optional(),
  }),
});

export const listSOSTicketsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(SOSTicketStatus).optional(),
  }),
});

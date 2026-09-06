/**
 * Hacker SOS contracts.
 *
 * `coordinates` is required on ticket creation because dispatch ranks responders by
 * Haversine distance to this point — a ticket without a position cannot be routed
 * meaningfully. (The service carries a Siebel-Atrium fallback for direct internal calls;
 * this schema is what stops it being reachable over HTTP.)
 *
 * `karmaBounty` has a floor of 50 so incidents are worth answering. It has no ceiling,
 * which means a caller can mint an arbitrarily large reward — cap it before this is
 * exposed to attendees.
 */
import { z } from 'zod';
import { objectId } from './common';
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
    id: objectId('Invalid Ticket ObjectId'),
  }),
});

export const resolveSOSTicketSchema = z.object({
  params: z.object({
    id: objectId('Invalid Ticket ObjectId'),
  }),
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
  }),
});

export const listSOSTicketsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(SOSTicketStatus).optional(),
  }),
});

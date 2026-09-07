/**
 * Hacker SOS contracts.
 *
 * `coordinates` is required on ticket creation because dispatch ranks responders by
 * Haversine distance to this point — a ticket without a position cannot be routed
 * meaningfully. (The service carries a Siebel-Atrium fallback for direct internal calls;
 * this schema is what stops it being reachable over HTTP.)
 *
 * `karmaBounty` has a floor of 50 so incidents are worth answering and a ceiling of 500 so a
 * ticket creator cannot mint an arbitrary reward. The floor lives here rather than on the
 * model deliberately: fifty is a judgement about what is worth a responder's walk and it
 * applies to what somebody *asks for*, whereas a stored zero means no reward is attached at
 * all — see the validator on `SOSTicket.karmaBounty`, which is why the model permits zero and
 * this schema does not.
 *
 * The 500 here is now the weaker of two ceilings and no longer the interesting one. The
 * pack's per-urgency `bountyCap` and its `hackerBountyBudgetPerDay` are both live in
 * `SOSService.create`, and the budget is what the `bountyLedger` row enforces atomically. Note
 * the shipped pack allows 800 for CRITICAL, so this literal is what actually binds there: a
 * fork that raises a per-urgency cap above 500 will find the schema refusing it first.
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
    // Optional: omitting it takes the service's default rather than offering nothing, so a
    // hacker in trouble does not have to price their own emergency.
    karmaBounty: z.number().int().min(50).max(500).optional(), // see the header: the pack's per-urgency cap is the other ceiling
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

/** Acknowledge / on-scene / cancel / reassign: the id in the path, an optional note. */
export const ticketActionSchema = z.object({
  params: z.object({ id: objectId('Invalid SOS ticket id') }),
  body: z.object({ note: z.string().max(280).optional() }).optional(),
});

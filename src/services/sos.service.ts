/**
 * Hacker SOS — distress tickets and nearest-responder dispatch.
 *
 * A hacker in trouble at 3 AM raises a ticket with a location and a required skill.
 * Dispatch picks the nearest on-duty volunteer who actually holds that certification,
 * by Haversine distance — nearest *qualified*, not merely nearest, because a first-aid
 * call routed to the closest person who cannot give first aid is a slower non-answer.
 *
 * Resolution is where the money is, so it is guarded twice. A dispatched ticket pays its
 * bounty only to the volunteer it was dispatched to; a stranger resolving someone else's
 * ticket is bounty theft, and that check is an identity comparison routed through
 * `sameId` so it cannot be defeated by spelling an id in a different case. An OPEN ticket
 * is claimable by whoever resolves it first, and the status transition is a
 * compare-and-swap, so two simultaneous resolvers produce one payment and one clean
 * conflict rather than two payouts.
 *
 * **Known gap:** the bounty is uncapped and caller-supplied at ticket creation.
 */
import { Types } from 'mongoose';
import { SOSTicket, ISOSTicket, SOSTicketStatus, SOSTicketCategory, SOSTicketUrgency } from '../models/sosTicket.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, IVolunteer, computePrestigeTier } from '../models/volunteer.model';
import { IShift } from '../models/shift.model';
import { GeoEngine, HACKILLINOIS_VENUES, IGeoCoordinates, resolveVenueCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { sameId } from '../common/utils/id';


export interface ICreateSOSTicketDTO {
  hackerName: string;
  tableLocation: string;
  coordinates?: IGeoCoordinates;
  category: SOSTicketCategory;
  description: string;
  urgency: SOSTicketUrgency;
  requiredSkill?: string;
  karmaBounty?: number;
}

export class SOSService {
  /**
   * Hacker creates an emergency logistics / hardware help ticket.
   */
  public static async createTicket(dto: ICreateSOSTicketDTO): Promise<ISOSTicket> {
    const coords = dto.coordinates || HACKILLINOIS_VENUES.SIEBEL_ATRIUM;

    const ticket = await SOSTicket.create({
      ...dto,
      coordinates: coords,
      status: SOSTicketStatus.OPEN,
      karmaBounty: dto.karmaBounty || 150,
    });

    eventHub.broadcast({
      type: 'SOS_TICKET_CREATED',
      data: ticket.toObject(),
    });

    return ticket;
  }

  /**
   * Spatial Nearest-Neighbor Dispatch:
   * Finds on-duty volunteers, filters by skill certification,
   * calculates Haversine distance to the ticket coordinates,
   * and dispatches the closest volunteer.
   */
  public static async dispatchNearestVolunteer(ticketId: string): Promise<{
    ticket: ISOSTicket;
    dispatchedVolunteer: Record<string, unknown>;
    distanceMeters: number;
  }> {
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket || ticket.status !== SOSTicketStatus.OPEN) {
      throw ApiError.notFound('Open SOS ticket not found.');
    }

    // 1. On-duty pool, tiered: CHECKED_IN first, then CONFIRMED (holding a
    // shift but not yet scanned). Tiering preserves dispatch availability when
    // nobody has checked in yet, without the old fallback's fabricated 15m
    // telemetry (it assigned a random volunteer and reported a fake distance).
    let activeRegs = await Registration.find({ status: RegistrationStatus.CHECKED_IN })
      .populate('volunteerId')
      .populate('shiftId');

    if (activeRegs.length === 0) {
      activeRegs = await Registration.find({ status: RegistrationStatus.CONFIRMED })
        .populate('volunteerId')
        .populate('shiftId');
    }

    if (activeRegs.length === 0) {
      throw ApiError.conflict('No on-duty volunteers available for dispatch.', ErrorCode.SCHEDULE_CONFLICT);
    }

    // 2. Score candidates by skill match and distance
    let bestCandidate: IVolunteer | null = null;
    let shortestDistance = Infinity;

    // Estimate volunteer location from the volunteer's shift venue (resolved, never defaulted).
    for (const reg of activeRegs) {
      const vol = reg.volunteerId as unknown as IVolunteer;
      const shift = reg.shiftId as unknown as IShift;
      if (!vol || !shift?.location) continue;

      // Check skill if required
      if (ticket.requiredSkill && !vol.certifications.includes(ticket.requiredSkill)) {
        continue;
      }

      const venueCoord = resolveVenueCoordinates(shift.location);
      if (!venueCoord) continue; // unmappable shift venue — skip instead of measuring from the wrong building
      const dist = GeoEngine.haversineDistanceMeters(ticket.coordinates, venueCoord);

      if (dist < shortestDistance) {
        shortestDistance = dist;
        bestCandidate = vol;
      }
    }

    // ponytail: no skill-match wipeout fallback — assigning a random unqualified volunteer is worse than no dispatch.
    if (!bestCandidate) {
      throw ApiError.conflict('No on-duty volunteer matches the required skill for this ticket.', ErrorCode.MISSING_SKILL_CERTIFICATION);
    }

    // 3. CAS the ticket OPEN -> DISPATCHED so concurrent dispatchers can't double-assign.
    const dispatched = await SOSTicket.findOneAndUpdate(
      { _id: ticket._id, status: SOSTicketStatus.OPEN },
      { $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: bestCandidate._id, dispatchedAt: new Date() } },
      { new: true }
    );
    if (!dispatched) {
      throw ApiError.conflict('Ticket was already dispatched by another coordinator.', ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS);
    }

    eventHub.broadcast({
      type: 'SOS_TICKET_DISPATCHED',
      data: {
        ticketId: ticket._id,
        hackerName: ticket.hackerName,
        tableLocation: ticket.tableLocation,
        volunteerId: bestCandidate._id,
        volunteerName: bestCandidate.name,
        distanceMeters: shortestDistance,
      },
    });

    return {
      ticket: dispatched,
      dispatchedVolunteer: (bestCandidate.toObject ? bestCandidate.toObject() : bestCandidate) as Record<string, unknown>,
      distanceMeters: shortestDistance,
    };
  }

  /**
   * Volunteer resolves the SOS ticket, earns karma bounty, and unlocks FIRST_RESPONDER badge.
   * ponytail: assignee-bound + CAS — strangers can't claim others' bounties, concurrent resolves can't double-pay.
   */
  public static async resolveTicket(ticketId: string, volunteerId: string): Promise<ISOSTicket> {
    if (!volunteerId) {
      throw ApiError.badRequest('volunteerId (resolving volunteer) is required.');
    }
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket) {
      throw ApiError.notFound('SOS ticket not found.');
    }

    if (ticket.status === SOSTicketStatus.RESOLVED) {
      throw ApiError.conflict('Ticket is already resolved.');
    }

    // ponytail: assignee-bound — a dispatched ticket pays its bounty only to the
    // dispatched volunteer. Strangers resolving others' tickets is bounty theft.
    // OPEN tickets are claimed by whoever resolves first (CAS below serializes races).
    if (ticket.status === SOSTicketStatus.DISPATCHED && !sameId(ticket.assignedVolunteerId, volunteerId)) {
      throw ApiError.forbidden('Only the dispatched volunteer may resolve this ticket.');
    }

    // CAS the status transition; loser of the race gets a clean 409 instead of a double bounty.
    const resolved = await SOSTicket.findOneAndUpdate(
      { _id: ticket._id, status: { $in: [SOSTicketStatus.OPEN, SOSTicketStatus.DISPATCHED] } },
      { $set: { status: SOSTicketStatus.RESOLVED, resolvedAt: new Date(), ...(ticket.status === SOSTicketStatus.OPEN ? { assignedVolunteerId: new Types.ObjectId(volunteerId), dispatchedAt: new Date() } : {}) } },
      { new: true }
    );
    if (!resolved) {
      throw ApiError.conflict('Ticket is already resolved.', ErrorCode.SCHEDULE_CONFLICT);
    }

    // Award karma bounty atomically ($inc — concurrent resolves can't lost-update).
    const vol = await Volunteer.findOneAndUpdate(
      { _id: new Types.ObjectId(volunteerId) },
      { $inc: { karmaPoints: resolved.karmaBounty }, $addToSet: { badges: 'FIRST_RESPONDER' } },
      { new: true }
    );

    // Recompute prestige tier from the new balance (single follow-up write; karma itself is already atomic).
    if (vol) {
      const tier = computePrestigeTier(vol.karmaPoints);
      if (tier !== vol.prestigeTier) {
        await Volunteer.updateOne({ _id: vol._id }, { $set: { prestigeTier: tier } });
      }
    }

    eventHub.broadcast({
      type: 'SOS_TICKET_RESOLVED',
      data: {
        ticketId: resolved._id,
        volunteerId,
        volunteerName: vol ? vol.name : 'Volunteer',
        karmaAwarded: resolved.karmaBounty,
        totalKarma: vol ? vol.karmaPoints : 0,
      },
    });

    return resolved;
  }

  /**
   * Lists SOS tickets with optional status filtering.
   */
  public static async listTickets(status?: SOSTicketStatus): Promise<ISOSTicket[]> {
    const query = status ? { status } : {};
    return SOSTicket.find(query)
      .populate('assignedVolunteerId', 'name email role')
      .sort({ createdAt: -1 });
  }
}

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
import { SOSTicket, ISOSTicket, SOSTicketStatus, SOSTicketCategory, SOSTicketUrgency, canTransition } from '../models/sosTicket.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, IVolunteer, computePrestigeTier } from '../models/volunteer.model';
import { IShift } from '../models/shift.model';
import { GeoEngine, HACKILLINOIS_VENUES, IGeoCoordinates, resolveVenueCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { presenceStore } from '../presence/store';
import { PresenceAudit } from '../models/presenceAudit.model';
import { toLocal } from '../content/loader';
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

/** A presence fix older than this is not a position any more; fall back to the venue. */
const LIVE_POSITION_MAX_AGE_MS = 30_000;

/** Lead-or-above, the only role that may reassign, cancel a dispatched ticket, or see exact distances. */
const isLeadRole = (role?: string): boolean => /SHIFT_LEAD|ORGANIZER|ADMIN/.test(role ?? '');

/** Distances shown to non-leads are rounded to this, so they cannot be used to range. */
const DISTANCE_BUCKET_M = 10;
const coarsen = (m: number): number | null => (Number.isFinite(m) ? Math.round(m / DISTANCE_BUCKET_M) * DISTANCE_BUCKET_M : null);

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
  public static async dispatchNearestVolunteer(ticketId: string, viewer?: { role?: string }): Promise<{
    ticket: ISOSTicket;
    dispatchedVolunteer: Record<string, unknown>;
    distanceMeters: number | null;
    positionSource: 'live' | 'venue' | 'unknown';
    positionAgeMs: number | null;
    candidates: Array<{ volunteerId: string; name: string; distanceMeters: number | null; positionSource: string; ageMs: number | null }>;
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

    // 2. Rank candidates. A live presence fix (opted in, on duty, < 30 s old) beats the
    // shift-venue estimate, which beats nothing at all: a candidate with neither is kept
    // and ranked last with positionSource 'unknown' so the lead queue shows them greyed
    // rather than silently dropping them. Hackers are never candidates, and an opted-out
    // volunteer simply falls back to their venue — opting out is honoured by dispatch too.
    const now = Date.now();
    const live = new Map<string, { distanceM: number; ageMs: number }>();
    for (const p of presenceStore.nearestVolunteers(
      toLocal(ticket.coordinates.latitude, ticket.coordinates.longitude).x,
      toLocal(ticket.coordinates.latitude, ticket.coordinates.longitude).z,
      LIVE_POSITION_MAX_AGE_MS,
      now,
      500
    )) {
      live.set(p.e.id, { distanceM: p.distanceM, ageMs: p.ageMs });
    }

    type Candidate = {
      vol: IVolunteer;
      distanceMeters: number | null;
      positionSource: 'live' | 'venue' | 'unknown';
      ageMs: number | null;
    };
    const candidates: Candidate[] = [];

    for (const reg of activeRegs) {
      const vol = reg.volunteerId as unknown as IVolunteer;
      const shift = reg.shiftId as unknown as IShift;
      if (!vol) continue;
      if ((vol as { kind?: string }).kind === 'HACKER') continue;

      // Check skill if required
      if (ticket.requiredSkill && !vol.certifications.includes(ticket.requiredSkill)) {
        continue;
      }

      const fix = live.get(String(vol._id));
      if (fix) {
        candidates.push({ vol, distanceMeters: fix.distanceM, positionSource: 'live', ageMs: fix.ageMs });
        continue;
      }
      const venueCoord = shift?.location ? resolveVenueCoordinates(shift.location) : null;
      if (venueCoord) {
        candidates.push({
          vol,
          distanceMeters: GeoEngine.haversineDistanceMeters(ticket.coordinates, venueCoord),
          positionSource: 'venue',
          ageMs: null,
        });
        continue;
      }
      // Unmappable venue and no live fix: still a person who could respond.
      candidates.push({ vol, distanceMeters: null, positionSource: 'unknown', ageMs: null });
    }

    // Live fixes first, then venue estimates, then unknown; distance within each tier.
    const rank = { live: 0, venue: 1, unknown: 2 } as const;
    candidates.sort((a, b) =>
      rank[a.positionSource] - rank[b.positionSource] ||
      (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity)
    );

    const winner = candidates[0];
    const bestCandidate: IVolunteer | null = winner ? winner.vol : null;
    const shortestDistance = winner?.distanceMeters ?? Infinity;

    // One audit document per dispatch — never one per scanned cell (plan §A4). Written
    // even when no live fix was used: "we looked and found nobody publishing" is exactly
    // the kind of read the log exists to record.
    await PresenceAudit.create({
      readerId: 'dispatch',
      reason: 'dispatch',
      ticketId: String(ticket._id),
      candidatesScanned: candidates.length,
      winnerId: bestCandidate ? String(bestCandidate._id) : undefined,
      at: new Date(now),
    });

    // ponytail: no skill-match wipeout fallback — assigning a random unqualified volunteer
    // is worse than no dispatch at all.
    if (!bestCandidate || !winner) {
      throw ApiError.conflict('No on-duty volunteer matches the required skill for this ticket.', ErrorCode.MISSING_SKILL_CERTIFICATION);
    }

    const isLead = /SHIFT_LEAD|ORGANIZER|ADMIN/.test(viewer?.role ?? '');

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
        distanceMeters: Number.isFinite(shortestDistance) ? shortestDistance : null,
        positionSource: winner!.positionSource,
      },
    });

    return {
      ticket: dispatched,
      // Only what the dispatcher needs to see; never the full account document (email, phone,
      // identities, sessionVersion).
      dispatchedVolunteer: {
        _id: bestCandidate._id,
        name: bestCandidate.name,
        role: bestCandidate.role,
        faction: (bestCandidate as { faction?: unknown }).faction,
      } as Record<string, unknown>,
      // Coarsened to 10 m for an ordinary caller: an exact metre distance from a chosen
      // point is a ranging oracle, and repeated across tickets it trilaterates a live
      // position that the fuzzed wire deliberately withholds. Leads already read exact
      // positions through the audited `GET /presence`.
      distanceMeters: isLead ? shortestDistance : coarsen(shortestDistance),
      positionSource: winner!.positionSource,
      positionAgeMs: winner!.ageMs,
      /**
       * The runners-up, for the lead queue's "who else could go" column. Ordinary callers
       * get nothing here: they asked to dispatch, not to survey where everyone is.
       */
      candidates: isLead
        ? candidates.slice(0, 10).map((c) => ({
            volunteerId: String(c.vol._id),
            name: c.vol.name,
            distanceMeters: c.distanceMeters,
            positionSource: c.positionSource,
            ageMs: c.ageMs,
          }))
        : [],
    };
  }

  /**
   * One guarded state change (plan §A7). Every move goes through the `SOS_TRANSITIONS`
   * table and appends to `history`, so the ticket carries its own timeline and an illegal
   * move is a 409 rather than a silently overwritten status. The CAS on `status` is what
   * makes two coordinators pressing the same button safe.
   */
  private static async transition(
    ticketId: string,
    to: SOSTicketStatus,
    actor: { id?: string; role?: string; kind?: string },
    opts: { note?: string; set?: Record<string, unknown>; requireAssignee?: boolean } = {}
  ): Promise<ISOSTicket> {
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket) throw ApiError.notFound('SOS ticket not found.');
    const from = ticket.status;
    if (!canTransition(from, to)) {
      throw ApiError.conflict(`An SOS ticket cannot go from ${from} to ${to}.`, ErrorCode.SCHEDULE_CONFLICT);
    }
    if (opts.requireAssignee && !sameId(ticket.assignedVolunteerId, actor.id) && !isLeadRole(actor.role)) {
      throw ApiError.forbidden('Only the assigned responder (or a lead) can do that.');
    }
    const updated = await SOSTicket.findOneAndUpdate(
      { _id: ticket._id, status: from },
      {
        $set: { status: to, ...(opts.set ?? {}) },
        $push: { history: { status: to, at: new Date(), by: actor.id ? new Types.ObjectId(actor.id) : null, note: opts.note } },
      },
      { new: true }
    );
    if (!updated) {
      throw ApiError.conflict('Someone else moved this ticket first.', ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS);
    }
    SOSService.publish(updated, `SOS_TICKET_${to}`);
    return updated;
  }

  /** The full ticket to lead+ and the parties; a redacted copy to everyone else. */
  private static publish(ticket: ISOSTicket, type: string): void {
    eventHub.broadcast({
      type,
      data: {
        ticketId: ticket._id,
        status: ticket.status,
        venueKey: ticket.tableLocation,
        category: ticket.category,
        urgency: ticket.urgency,
        hackerName: ticket.hackerName,
        tableLocation: ticket.tableLocation,
        assignedVolunteerId: ticket.assignedVolunteerId,
      },
    });
    // The creator and the assignee always get the full ticket on their own channel.
    for (const party of [ticket.createdById, ticket.assignedVolunteerId]) {
      if (party) eventHub.sendToAccount(String(party), { type, data: { ticketId: ticket._id, status: ticket.status, ticket } });
    }
  }

  /** The responder says "on my way". */
  public static acknowledge(ticketId: string, actor: { id?: string; role?: string }): Promise<ISOSTicket> {
    return SOSService.transition(ticketId, SOSTicketStatus.ACKNOWLEDGED, actor, {
      requireAssignee: true,
      set: { acknowledgedAt: new Date() },
    });
  }

  /** The responder is standing there. */
  public static arrive(ticketId: string, actor: { id?: string; role?: string }): Promise<ISOSTicket> {
    return SOSService.transition(ticketId, SOSTicketStatus.ON_SCENE, actor, {
      requireAssignee: true,
      set: { onSceneAt: new Date() },
    });
  }

  /**
   * Cancel. The creator may only cancel while the ticket is still OPEN — once somebody is
   * walking towards them, calling it off is a decision for the person who dispatched.
   * A lead may cancel from any non-terminal state.
   */
  public static async cancel(ticketId: string, actor: { id?: string; role?: string }, note?: string): Promise<ISOSTicket> {
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket) throw ApiError.notFound('SOS ticket not found.');
    const isCreator = sameId(ticket.createdById, actor.id);
    const lead = isLeadRole(actor.role);
    if (!lead && !(isCreator && ticket.status === SOSTicketStatus.OPEN)) {
      throw ApiError.forbidden('Only a lead can cancel a ticket once it has been dispatched.');
    }
    return SOSService.transition(ticketId, SOSTicketStatus.CANCELLED, actor, { note, set: { assignedVolunteerId: null } });
  }

  /** Send it back to the queue for someone else (lead+ only). */
  public static async reassign(ticketId: string, actor: { id?: string; role?: string }, note?: string): Promise<ISOSTicket> {
    if (!isLeadRole(actor.role)) throw ApiError.forbidden('Only a lead can reassign a ticket.');
    return SOSService.transition(ticketId, SOSTicketStatus.OPEN, actor, {
      note,
      set: { assignedVolunteerId: null, dispatchedAt: null, acknowledgedAt: null, onSceneAt: null },
    });
  }

  /**
   * Escalation sweep (plan §A7): a ticket dispatched more than three minutes ago that
   * nobody has acknowledged is shouted about once. The public `announce` copy carries no
   * coordinates, table text or names — it is readable by anyone — while lead+ subscribers
   * get the full ticket on `sos`.
   */
  public static async escalateStale(now: Date = new Date(), afterMs = 3 * 60_000): Promise<number> {
    const cutoff = new Date(now.getTime() - afterMs);
    const stale = await SOSTicket.find({
      status: SOSTicketStatus.DISPATCHED,
      dispatchedAt: { $lte: cutoff },
      escalatedAt: null,
    }).limit(50);
    for (const ticket of stale) {
      const claimed = await SOSTicket.findOneAndUpdate(
        { _id: ticket._id, escalatedAt: null },
        { $set: { escalatedAt: now } },
        { new: true }
      );
      if (!claimed) continue; // another instance got there first
      eventHub.broadcastChannel('announce', {
        type: 'SOS_ESCALATED',
        data: {
          ticketId: claimed._id,
          venueKey: claimed.tableLocation,
          urgency: claimed.urgency,
          minutesOpen: Math.round((now.getTime() - new Date(claimed.createdAt).getTime()) / 60_000),
        },
      });
      eventHub.broadcastChannel('sos', {
        type: 'SOS_ESCALATED_FULL',
        data: { ticketId: claimed._id, ticket: claimed },
      });
    }
    return stale.length;
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
      .populate('assignedVolunteerId', 'name role')
      .sort({ createdAt: -1 });
  }
}

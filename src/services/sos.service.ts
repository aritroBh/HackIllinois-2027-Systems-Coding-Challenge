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
 * The bounty is capped per urgency by the pack and drawn from the creator's daily budget, and
 * the person who raised a ticket can never be the person paid for closing it.
 */
import { Types } from 'mongoose';
import { SOSTicket, ISOSTicket, SOSTicketStatus, SOSTicketCategory, SOSTicketUrgency, canTransition } from '../models/sosTicket.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, IVolunteer, computePrestigeTier } from '../models/volunteer.model';
import { IShift } from '../models/shift.model';
import { GeoEngine, IGeoCoordinates, resolveVenueCoordinates, resolveVenue } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { presenceStore } from '../presence/store';
import { PresenceAudit } from '../models/presenceAudit.model';
import { KarmaService, KarmaSource } from './karma.service';
import { withTransactionRetry } from '../common/db/withTransactionRetry';
import { BountyService } from './bounty.service';
import { eventDay } from '../models/karmaLedger.model';
import { toLocal, pack } from '../content/loader';
import { eventHub } from '../common/sse/eventHub';
import { sameId } from '../common/utils/id';
import { domainEvents } from '../common/events/domainEvents';


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

/** What a ticket offers when the creator names no figure. The pack's per-urgency ceiling caps it. */
const DEFAULT_BOUNTY = 150;
const coarsen = (m: number): number | null => (Number.isFinite(m) ? Math.round(m / DISTANCE_BUCKET_M) * DISTANCE_BUCKET_M : null);

export class SOSService {
  /**
   * Hacker creates an emergency logistics / hardware help ticket.
   */
  public static async createTicket(dto: ICreateSOSTicketDTO, creator?: { id?: string; kind?: string }): Promise<ISOSTicket> {
    // Fail closed rather than defaulting to a building. A ticket with a fabricated position
    // sends a responder to the wrong place, which is worse than refusing the ticket and
    // asking again. The HTTP schema already requires coordinates; this covers direct callers.
    if (!dto.coordinates || !Number.isFinite(dto.coordinates.latitude) || !Number.isFinite(dto.coordinates.longitude)) {
      throw new ApiError(400, ErrorCode.MISSING_REQUIRED_FIELD, 'An SOS ticket needs the coordinates of the person who needs help.');
    }

    const urgency = dto.urgency ?? SOSTicketUrgency.MEDIUM;
    const ceiling = pack.event.bountyCap?.[urgency];
    const requested = dto.karmaBounty ?? DEFAULT_BOUNTY;
    if (ceiling !== undefined && requested > ceiling) {
      throw ApiError.badRequest(`A ${urgency} ticket may offer at most ${ceiling} karma.`);
    }

    // Every creator draws on a per-day budget, not only hackers.
    //
    // The debit and the ticket are one transaction: a reservation without a ticket would
    // silently eat someone's budget, and a ticket without a reservation is the hole the budget
    // exists to close. Exempting volunteers left exactly that hole open, and the route lets any
    // account create a ticket: two volunteers could alternate raising maximum-bounty tickets
    // and resolving each other's, minting karma without limit and without a ledger row to
    // show for it. Whether the money is capped cannot depend on which kind of account is
    // spending it.
    const budget = pack.event.hackerBountyBudgetPerDay ?? 0;
    const chargesBudget = !!creator?.id && budget > 0;

    let ticket: ISOSTicket;
    if (chargesBudget) {
      ticket = await withTransactionRetry(async (session) => {
        const reserved = await BountyService.reserve(
          { accountId: creator!.id!, day: eventDay(), bounty: requested, budget },
          session
        );
        if (!reserved.ok) {
          throw new ApiError(409, ErrorCode.SCHEDULE_CONFLICT, "You have offered as much karma today as the event allows. Raise the ticket without a bounty, or ask a lead.");
        }
        const [created] = await SOSTicket.create(
          [{ ...dto, coordinates: dto.coordinates, status: SOSTicketStatus.OPEN, karmaBounty: requested, createdById: creator!.id }],
          { session }
        );
        return created;
      });
    } else {
      ticket = await SOSTicket.create({
        ...dto,
        coordinates: dto.coordinates,
        status: SOSTicketStatus.OPEN,
        karmaBounty: requested,
        createdById: creator?.id ?? null,
      });
    }

    SOSService.publish(ticket, 'SOS_TICKET_CREATED');
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

    // No fallback to the nearest unqualified volunteer. Sending someone who cannot do the
    // job marks the ticket handled and stops anyone else looking at it, which is slower
    // than an honest refusal that puts the ticket back in front of a human.
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

    // An unresolvable location is null, never the fallback venue.
    //
    // `resolveVenue` answers with SIEBEL_ATRIUM and `matched: false` when it recognises
    // nothing, which is the right default for a geofence — somewhere is better than nowhere
    // when you are deciding whether a check-in is plausible. It is the wrong answer on a
    // dispatch frame, where it reads as a fact: a ticket whose location the table cannot
    // parse was broadcast as being in Siebel Atrium, and a responder acting on that walks to
    // the wrong building while somebody waits somewhere else.
    const dispatchVenue = resolveVenue(ticket.tableLocation);
    eventHub.broadcast({
      type: 'SOS_TICKET_DISPATCHED',
      data: {
        ticketId: ticket._id,
        // `status` is on the redaction whitelist, so including it is what makes the copy an
        // ordinary subscriber receives a coherent statement rather than an id and a venue.
        status: SOSTicketStatus.DISPATCHED,
        urgency: ticket.urgency,
        category: ticket.category,
        hackerName: ticket.hackerName,
        tableLocation: ticket.tableLocation,
        volunteerId: bestCandidate._id,
        volunteerName: bestCandidate.name,
        // Coarsened even here: the hub drops this field for ordinary subscribers, but a
        // lead-visible frame is not a reason to put an exact range on the wire.
        distanceMeters: coarsen(shortestDistance),
        positionSource: winner!.positionSource,
        venueKey: dispatchVenue.matched ? dispatchVenue.key : null,
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
    // `venueKey` survives the hub's redaction for ordinary subscribers, so it must be a
    // resolved venue key and never the free-text table location. "Table 9, back left" is
    // exactly the detail the redaction exists to withhold; a venue key is a building.
    const venue = resolveVenue(ticket.tableLocation);
    const summary = {
      ticketId: ticket._id,
      status: ticket.status,
      venueKey: venue.matched ? venue.key : null,
      category: ticket.category,
      urgency: ticket.urgency,
      hackerName: ticket.hackerName,
      tableLocation: ticket.tableLocation,
      assignedVolunteerId: ticket.assignedVolunteerId,
      // The reward is advertised to responders on purpose — it is the reason to take the
      // ticket — and the hub's redaction whitelist drops it for callers who may not see the
      // rest. Leaving it out entirely meant the dispatch queue offered "+undefined karma".
      karmaBounty: ticket.karmaBounty,
    };
    eventHub.broadcast({ type, data: summary });

    // The creator and the assignee always get the full ticket on their own channel.
    //
    // The same shape as the broadcast, with the whole ticket added. It used to carry only the
    // id and the status, which meant a client subscribed to both `sos` and `me` — which is
    // every dashboard — received two frames of the same type with different fields, and any
    // handler written against one of them printed undefined for the other. A superset is
    // the shape that lets one handler serve both.
    for (const party of [ticket.createdById, ticket.assignedVolunteerId]) {
      if (party) eventHub.sendToAccount(String(party), { type, data: { ...summary, ticket } });
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
      // `announce` is the one channel anybody may join without a session, so what goes on it
      // is public. `venueKey` here was the raw `tableLocation` — "Table 42, back left, by the
      // outlets" — which is precisely the string the redaction elsewhere in this file exists
      // to withhold, published to anyone who opens the stream, about somebody who has been
      // waiting three minutes for help. It is resolved to a building key like every other
      // path, and an unresolvable location becomes null rather than the text.
      const escalationVenue = resolveVenue(claimed.tableLocation);
      eventHub.broadcastChannel('announce', {
        type: 'SOS_ESCALATED',
        data: {
          ticketId: claimed._id,
          venueKey: escalationVenue.matched ? escalationVenue.key : null,
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
   *
   * This is where the money moves, so it is guarded twice. A dispatched ticket pays only the
   * volunteer it was dispatched to, or a stranger can walk in and take a bounty someone else
   * is already answering. The status transition is a compare-and-swap, so two resolvers
   * arriving together produce one payment and one conflict rather than two payments.
   */
  public static async resolveTicket(ticketId: string, volunteerId: string): Promise<ISOSTicket> {
    if (!volunteerId) {
      throw ApiError.badRequest('volunteerId (resolving volunteer) is required.');
    }
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket) {
      throw ApiError.notFound('SOS ticket not found.');
    }

    const observed = ticket.status;
    if (!canTransition(observed, SOSTicketStatus.RESOLVED)) {
      // A second resolve of the same ticket is the common case here and deserves the plain
      // words for it. The generic edge message is right for the other refusals (a cancelled
      // ticket, say) but would tell somebody whose colleague just closed the ticket that it
      // "cannot go from RESOLVED to RESOLVED", which reads as a bug rather than as an answer.
      throw ApiError.conflict(
        observed === SOSTicketStatus.RESOLVED
          ? 'This SOS ticket is already resolved.'
          : `An SOS ticket cannot go from ${observed} to RESOLVED.`,
        ErrorCode.SCHEDULE_CONFLICT
      );
    }

    // Nobody collects a bounty on their own ticket.
    //
    // Resolving an OPEN ticket is deliberately open to whoever gets there first — somebody
    // who happens to be standing next to the problem should not have to wait for dispatch.
    // But that also let the person who RAISED the ticket resolve it and pay themselves,
    // which is not a race anybody can lose: raise a ticket at the maximum bounty, resolve it,
    // repeat. The budget above caps the rate; this closes the loop entirely.
    //
    // Checked before the assignee rule so that the message is the true reason: a creator who
    // has somehow also been dispatched to their own ticket is still refused here.
    if (ticket.createdById && sameId(ticket.createdById, volunteerId)) {
      throw ApiError.forbidden('You cannot resolve a ticket you raised yourself.');
    }

    // Assignee-bound once somebody has been sent: a ticket that is on its way to a named
    // responder pays that responder. An OPEN ticket is claimed by whoever resolves it first.
    const claimed = observed !== SOSTicketStatus.OPEN;
    if (claimed && !sameId(ticket.assignedVolunteerId, volunteerId)) {
      throw ApiError.forbidden('Only the dispatched volunteer may resolve this ticket.');
    }

    // A real compare-and-set: the filter names the status we READ, not the set of statuses
    // that happen to be resolvable. Matching a broader set let a ticket that was OPEN a
    // moment ago but has since been dispatched to somebody else still match, and the
    // OPEN-shaped payload would then overwrite the assignee and pay the wrong person. The
    // loser of the race gets a clean 409.
    const resolved = await SOSTicket.findOneAndUpdate(
      { _id: ticket._id, status: observed },
      {
        $set: {
          status: SOSTicketStatus.RESOLVED,
          resolvedAt: new Date(),
          ...(claimed ? {} : { assignedVolunteerId: new Types.ObjectId(volunteerId), dispatchedAt: new Date() }),
        },
        $push: { history: { status: SOSTicketStatus.RESOLVED, at: new Date(), by: new Types.ObjectId(volunteerId) } },
      },
      { new: true }
    );
    if (!resolved) {
      throw ApiError.conflict('Ticket is already resolved.', ErrorCode.SCHEDULE_CONFLICT);
    }

    // Award karma bounty atomically ($inc — concurrent resolves can't lost-update).
    await Volunteer.updateOne({ _id: new Types.ObjectId(volunteerId) }, { $addToSet: { badges: 'FIRST_RESPONDER' } });
    await KarmaService.awardKarma(volunteerId, resolved.karmaBounty, KarmaSource.SOS, { ticketId: String(resolved._id) });
    const vol = await Volunteer.findById(volunteerId);

    // Recompute prestige tier from the new balance (single follow-up write; karma itself is already atomic).
    if (vol) {
      const tier = computePrestigeTier(vol.karmaPoints);
      if (tier !== vol.prestigeTier) {
        await Volunteer.updateOne({ _id: vol._id }, { $set: { prestigeTier: tier } });
      }
    }

    domainEvents.emit('sos.resolved', {
      ticketId: String(resolved._id),
      resolverId: volunteerId,
      category: String(resolved.category),
      venueKey: resolveVenue(resolved.tableLocation).key,
    });

    const resolvedVenue = resolveVenue(resolved.tableLocation);
    const resolvedSummary = {
      ticketId: resolved._id,
      status: SOSTicketStatus.RESOLVED,
      urgency: resolved.urgency,
      category: resolved.category,
      venueKey: resolvedVenue.matched ? resolvedVenue.key : null,
      karmaBounty: resolved.karmaBounty,
      volunteerId,
      volunteerName: vol ? vol.name : 'Volunteer',
      karmaAwarded: resolved.karmaBounty,
      totalKarma: vol ? vol.karmaPoints : 0,
    };
    eventHub.broadcast({ type: 'SOS_TICKET_RESOLVED', data: resolvedSummary });

    // The creator and the responder get the full record on their own channel, as every other
    // transition does. Resolution was the one that did not, so the hacker who raised the
    // ticket — the person most entitled to know it is closed — learned nothing from the wire
    // and had to poll for it.
    for (const party of [resolved.createdById, resolved.assignedVolunteerId]) {
      if (party) eventHub.sendToAccount(String(party), { type: 'SOS_TICKET_RESOLVED', data: { ...resolvedSummary, ticket: resolved } });
    }

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

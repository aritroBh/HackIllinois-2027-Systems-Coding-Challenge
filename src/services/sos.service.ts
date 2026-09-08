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


/**
 * What raising a distress call needs.
 *
 * `coordinates` is optional in this type and mandatory in fact — `createTicket` refuses a
 * ticket without finite ones rather than defaulting to a building, because a fabricated
 * position sends a responder to the wrong place, which is worse than asking again.
 *
 * `requiredSkill` is the filter dispatch applies to the candidate pool, and naming one is a
 * real trade: it narrows the pool to the point where a call can go unanswered rather than
 * answered by somebody who cannot do the job. Dispatch takes that side deliberately.
 *
 * `karmaBounty` is a request, not a grant. The pack's per-urgency ceiling caps it, the
 * creator's daily budget pays for it, and the responder's own daily karma cap can clamp what
 * is actually paid out to less than the figure on the ticket.
 */
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

/**
 * How long after a shift ends its holder is still a plausible responder.
 *
 * The candidate pool is every registration in a CHECKED_IN (or, failing that, CONFIRMED)
 * state, and nothing ever asked *when*. Check-out is a thing volunteers forget, so a row
 * stays CHECKED_IN indefinitely — and at three in the morning the nearest "on-duty"
 * volunteer was somebody who went to bed at nine. The ticket is marked DISPATCHED, which
 * stops anybody else looking at it, and the person in distress waits for a responder who is
 * asleep. That is the worst failure this system has, and it came from a missing clause.
 *
 * Half an hour matches the check-in grace and the rest buffer: someone whose shift ended
 * twenty minutes ago is plausibly still in the building; someone whose shift ended
 * yesterday is not.
 */
const ON_DUTY_GRACE_MS = 30 * 60_000;

/** Lead-or-above, the only role that may reassign, cancel a dispatched ticket, or see exact distances. */
const isLeadRole = (role?: string): boolean => /SHIFT_LEAD|ORGANIZER|ADMIN/.test(role ?? '');

/**
 * A lead who *proved* it, for the decisions that disclose somebody else's position.
 *
 * `legacy` mode believes a `volunteerId` in the body or query, and `GET /volunteers` hands
 * out account ids and roles to anonymous callers — so a claimed lead is one public string
 * away from anybody. Five earlier fixes established that staff *reads* must check
 * `source === 'session'`; the two below never got it, which meant the full ticket document
 * and the exact dispatch distances were readable without a credential, reopening the ranging
 * oracle round four closed and the coordinate disclosure round C closed.
 *
 * Deliberately narrower than `isLeadRole`: the lifecycle *actions* (reassign, the lead
 * override on acknowledge and resolve) stay as they are, because `legacy` is documented as an
 * open demo for actions. Disclosure is the thing that cannot be taken back.
 */
const isProvenLead = (viewer?: { role?: string; source?: string }): boolean =>
  viewer?.source === 'session' && isLeadRole(viewer.role);

/**
 * The only shape of an SOS ticket a caller who is not a proved lead or a party may receive.
 *
 * Enough to render a queue and decide whether to help; nothing that says **where a named person
 * is or what is wrong with them**. Withheld: `coordinates`, `tableLocation`, `hackerName`,
 * `description`, `createdById`, `assignedVolunteerId`.
 *
 * This lives in one function because the same disclosure has now been reopened four times in
 * four different branches — the `sos` SSE channel, `GET /sos/tickets` for a non-party, that same
 * route's *party* exception, and the dispatch response, which returned the whole Mongoose
 * document while every other field beside it was being carefully trimmed. Each was fixed on its
 * own and each left a sibling. A shared shape means the next reader has one thing to check
 * rather than four, and adding a field to it is a decision made once.
 */
export function redactedTicket(t: ISOSTicket): Record<string, unknown> {
  const venue = resolveVenue(t.tableLocation);
  return {
    _id: t._id,
    status: t.status,
    venueKey: venue.matched ? venue.key : null,
    category: t.category,
    urgency: t.urgency,
    karmaBounty: t.karmaBounty,
    createdAt: t.createdAt,
  };
}

/**
 * Distances shown to non-leads are rounded to this, so they cannot be used to range.
 *
 * Twenty-five metres, not ten, and measured against the *published* position rather than
 * the exact one — the two go together. Dispatch is an exact reader, and it was quoting a
 * distance derived from that exact position to a bucket finer than the twenty-metre fuzz
 * grid. Anyone who can raise a ticket can choose its coordinates, and any volunteer can
 * dispatch one: three tickets at three chosen points, three ranges good to ten metres, and
 * a colleague's true position falls out by trilateration — the fuzz undone by arithmetic,
 * with no exact-read audit row anywhere, because no exact position was ever *returned*.
 *
 * A bucket coarser than the fuzz cell, applied to a distance that already went through the
 * fuzz, leaves the oracle no sharper than the map every player can see.
 */
const DISTANCE_BUCKET_M = 25;

/** What a ticket offers when the creator names no figure. The pack's per-urgency ceiling caps it. */
const DEFAULT_BOUNTY = 150;
const coarsen = (m: number): number | null => (Number.isFinite(m) ? Math.round(m / DISTANCE_BUCKET_M) * DISTANCE_BUCKET_M : null);

/**
 * The ticket as this caller may see it — full for a proved lead or a proved party, redacted
 * otherwise.
 *
 * Every SOS **lifecycle** response goes through here. Acknowledging, arriving, cancelling,
 * reassigning and resolving are *actions*, and `legacy` is documented as believing a claimed
 * identity for actions — but each of them answered with the whole ticket document, and that is
 * a *disclosure*. `POST /tickets/:id/acknowledge?volunteerId=<the assignee>` from an anonymous
 * caller passed the assignee check and was handed the coordinates, the hacker's name, the table
 * and the medical category; naming any lead's public id passed every lead override too.
 *
 * So the action stays believable and the answer does not. A responder who has actually proved
 * who they are still gets the address they are walking to; anyone else gets a receipt.
 */
export function ticketFor(
  t: ISOSTicket,
  viewer?: { id?: string; role?: string; source?: string }
): ISOSTicket | Record<string, unknown> {
  if (isProvenLead(viewer)) return t;
  const proved = viewer?.source === 'session' && !!viewer.id;
  if (proved && (sameId(t.createdById, viewer!.id!) || sameId(t.assignedVolunteerId, viewer!.id!))) return t;
  return redactedTicket(t);
}

/**
 * Emergency distress dispatch service coordinating hacker incident tickets, nearest responder routing, and resolution.
 */
export class SOSService {
  /**
   * Raise a ticket.
   *
   * Two things here are easy to miss. The bounty is *charged*, not merely declared: the
   * budget reservation and the ticket insert are one transaction, so there is no state in
   * which somebody's daily budget was spent on a ticket that does not exist, or a ticket
   * exists that nobody was charged for.
   *
   * And the charge does not depend on who is asking. The name says hacker; the route admits
   * any account, and a volunteer creator draws on the same per-day budget — because
   * exempting them leaves two volunteers free to alternate raising and resolving each
   * other's maximum-bounty tickets, minting karma with no ceiling and no ledger row to show
   * for it. Whether money is capped cannot depend on the kind of account spending it.
   *
   * The two cases with nobody to charge — a creatorless ticket, and a pack whose daily
   * budget is zero — keep the ticket and drop the reward to nothing. The reasoning is at the
   * line, and it is the one place in this file where a rule about money is allowed to lose
   * to the fact that somebody needs help.
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
    let requested = dto.karmaBounty ?? DEFAULT_BOUNTY;
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

    // A bounty nobody is charged for is a bounty nobody can be stopped from minting.
    //
    // Two paths reach here without a debit. A creatorless ticket — only possible in `legacy`
    // mode, where the route admits an anonymous caller — has nobody to charge and, worse,
    // nobody to compare against when the ticket is resolved, so the self-payout guard below
    // cannot fire either. And a pack that sets `hackerBountyBudgetPerDay: 0` plainly means
    // bounties are off, which is not the same as "unlimited"; reading it as no ceiling was
    // the opposite of what an operator writing a zero intends.
    //
    // Both cases keep the ticket — somebody still needs help — and drop the reward to zero.
    // Refusing the ticket instead would make an accounting rule into a reason not to answer
    // a distress call, which is the wrong thing to optimise.
    if (!chargesBudget && requested > 0) {
      const why = creator?.id ? 'the pack sets no daily bounty budget' : 'the ticket has no recorded creator';
      console.warn(`[sos] bounty dropped to zero: ${why}.`);
      requested = 0;
    }

    let ticket: ISOSTicket;
    if (chargesBudget) {
      ticket = await withTransactionRetry(async (session) => {
        const reserved = await BountyService.reserve(
          { accountId: creator!.id!, day: eventDay(), bounty: requested, budget },
          session
        );
        if (!reserved.ok) {
          throw new ApiError(409, ErrorCode.SCHEDULE_CONFLICT, `You have offered as much karma today as the event allows (${budget}). Ask a lead, or wait for tomorrow — your ticket will still be answered.`);
        }
        const [created] = await SOSTicket.create(
          [{ ...dto, coordinates: dto.coordinates, status: SOSTicketStatus.OPEN, karmaBounty: requested, createdById: creator!.id }],
          { session }
        );
        return created;
      }, {
        // A duplicate on the bounty ledger is two people opening their first row of the day
        // at the same instant, not a re-submitted request: the row exists now, so re-running
        // the body finds it and increments. Left fatal, one of the two got a 500.
        retryOnDuplicateIn: ['bountyledgers'],
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
   * Send the nearest qualified responder.
   *
   * Four decisions, in the order the code makes them, and each has been wrong before.
   *
   * **The pool is tiered, then filtered — in that order.** CHECKED_IN registrations are
   * tried first and CONFIRMED ones only when that tier comes back empty, and "empty" is
   * decided after the on-duty window but *before* the skill filter. So a CHECKED_IN tier
   * that holds people, none of whom carry the required certification, does not fall through
   * to the CONFIRMED tier — it refuses the dispatch instead. That is the safe direction, but
   * it is not what the code reads like at a glance.
   *
   * **On duty means both ends of the window.** A CHECKED_IN row stays that way forever if
   * somebody forgets to check out, and a CONFIRMED row for tomorrow afternoon has an
   * `endTime` comfortably in the future — so a start-of-window test is needed as well, with
   * half an hour of grace either side. See `ON_DUTY_GRACE_MS` for what a missing clause here
   * did at three in the morning.
   *
   * **Ranking is by source first, distance second.** Any live presence fix outranks any
   * venue estimate, and a venue estimate outranks having no position at all, so a volunteer
   * publishing from four hundred metres away is dispatched ahead of one whose shift venue is
   * next door. That is intended: the venue figure says where somebody is *scheduled* to be,
   * not where they are. A candidate with neither is kept and ranked last rather than dropped,
   * so a lead can still see them.
   *
   * **The assignment is a compare-and-swap from OPEN.** Two coordinators dispatching the
   * same ticket produce one assignment; the loser gets a 409, having already scanned every
   * position and already written its audit row — the log records that a read happened, not
   * that it won, which is the point of an audit. And there is deliberately no fallback to
   * the nearest unqualified volunteer: marking a ticket DISPATCHED stops everyone else
   * looking at it, so an honest refusal puts the call back in front of a human faster than a
   * wrong answer does.
   *
   * Almost every field of the return value is two-shaped, and the notes on each say why. A
   * dispatcher who has not *proved* they are a lead gets a redacted ticket, a bucketed
   * distance, no position age and no candidate list.
   */
  public static async dispatchNearestVolunteer(ticketId: string, viewer?: { id?: string; role?: string; source?: string }): Promise<{
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
    // Still on duty *now*, not merely once. A registration with no shift attached is kept:
    // an unresolvable reference is a data problem, and dropping the person because of it
    // would silently shrink the pool for a reason that has nothing to do with them.
    const dispatchNow = Date.now();
    const stillOnDuty = (reg: { shiftId?: unknown }): boolean => {
      const shift = reg.shiftId as unknown as IShift | null;
      if (!shift || !shift.endTime || !shift.startTime) return true;
      // Both ends of the window. Checking only the end covered the volunteer who forgot to
      // check out and left the other half open: the CONFIRMED tier exists for the hours when
      // nobody has scanned in yet, and a volunteer confirmed for tomorrow afternoon has an
      // `endTime` comfortably in the future. At half past three in the morning that is who
      // the ticket went to — somebody who is not at the event — and the ticket was marked
      // DISPATCHED, which stops anybody else looking at it.
      return (
        new Date(shift.endTime).getTime() + ON_DUTY_GRACE_MS >= dispatchNow &&
        new Date(shift.startTime).getTime() - ON_DUTY_GRACE_MS <= dispatchNow
      );
    };

    let activeRegs = (
      await Registration.find({ status: RegistrationStatus.CHECKED_IN }).populate('volunteerId').populate('shiftId')
    ).filter(stillOnDuty);

    if (activeRegs.length === 0) {
      activeRegs = (
        await Registration.find({ status: RegistrationStatus.CONFIRMED }).populate('volunteerId').populate('shiftId')
      ).filter(stillOnDuty);
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
    const live = new Map<string, { distanceM: number; publishedDistanceM: number; ageMs: number }>();
    for (const p of presenceStore.nearestVolunteers(
      toLocal(ticket.coordinates.latitude, ticket.coordinates.longitude).x,
      toLocal(ticket.coordinates.latitude, ticket.coordinates.longitude).z,
      LIVE_POSITION_MAX_AGE_MS,
      now,
      500
    )) {
      live.set(p.e.id, { distanceM: p.distanceM, publishedDistanceM: p.publishedDistanceM, ageMs: p.ageMs });
    }

    type Candidate = {
      vol: IVolunteer;
      /** Exact — ranking, and the lead's view. Never leaves this service un-coarsened for anyone else. */
      distanceMeters: number | null;
      /**
       * The same distance measured to the fuzzed position, for callers who are not entitled
       * to an exact read. A venue estimate has no fuzz to apply and no person to expose —
       * a venue centroid is on the map — so for those the two are the same number.
       */
      publishedDistanceMeters: number | null;
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
        candidates.push({
          vol,
          distanceMeters: fix.distanceM,
          publishedDistanceMeters: fix.publishedDistanceM,
          positionSource: 'live',
          ageMs: fix.ageMs,
        });
        continue;
      }
      const venueCoord = shift?.location ? resolveVenueCoordinates(shift.location) : null;
      if (venueCoord) {
        const venueDistance = GeoEngine.haversineDistanceMeters(ticket.coordinates, venueCoord);
        candidates.push({
          vol,
          distanceMeters: venueDistance,
          publishedDistanceMeters: venueDistance,
          positionSource: 'venue',
          ageMs: null,
        });
        continue;
      }
      // Unmappable venue and no live fix: still a person who could respond.
      candidates.push({ vol, distanceMeters: null, publishedDistanceMeters: null, positionSource: 'unknown', ageMs: null });
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
    const shortestPublishedDistance = winner?.publishedDistanceMeters ?? Infinity;

    // One audit document per dispatch — never one per scanned cell (plan §A4). Written
    // even when no live fix was used: "we looked and found nobody publishing" is exactly
    // the kind of read the log exists to record.
    await PresenceAudit.create({
      // Who read, not merely which subsystem. `docs/PRESENCE.md` promises the log answers
      // "who read whom and why", and a literal `'dispatch'` answers the second half only —
      // every dispatch in the event collapsed onto one indistinguishable reader, so the row
      // could not tell an ordinary night from one volunteer dispatching tickets at chosen
      // coordinates all evening. The subsystem is already in `reason`; this field is for the
      // account that asked. It falls back to the literal when there is no session behind the
      // call (the scheduler's own dispatches, and legacy-mode callers).
      readerId: viewer?.id ?? 'dispatch',
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

    const isLead = isProvenLead(viewer);

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
    // `resolveVenue` answers with the pack's `event.hqVenue` and `matched: false` when it
    // recognises nothing. (It named SIEBEL_ATRIUM until the gazetteer became pack-driven, and
    // that literal was the one branch a fork could never reach.) Note the fallback is a
    // *coordinate of last resort*, not a permission: check-in reads `matched` and refuses an
    // unrecognised location outright rather than measuring against it. It is the wrong answer on a
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
        distanceMeters: coarsen(shortestPublishedDistance),
        positionSource: winner!.positionSource,
        venueKey: dispatchVenue.matched ? dispatchVenue.key : null,
      },
    });

    return {
      // Redacted unless the dispatcher proved they are a lead.
      //
      // `dispatchedVolunteer` is trimmed, `distanceMeters` is bucketed and `candidates` is
      // emptied for an ordinary caller — and then the ticket itself went out as the raw
      // document beside them, carrying the coordinates, the hacker's name, the table text and
      // the medical category that all of that care was protecting. The route admits any
      // volunteer-kind caller, and in `legacy` that includes an anonymous one.
      //
      // The responder who is actually sent still gets the whole thing: it is delivered to them
      // on the targeted `me` channel, which is the path that already asks who they are.
      ticket: isLead ? dispatched : (redactedTicket(dispatched) as unknown as ISOSTicket),
      // Only what the dispatcher needs to see; never the full account document (email, phone,
      // identities, sessionVersion).
      dispatchedVolunteer: {
        _id: bestCandidate._id,
        name: bestCandidate.name,
        role: bestCandidate.role,
        faction: (bestCandidate as { faction?: unknown }).faction,
      } as Record<string, unknown>,
      // Exact for a lead, who is an entitled reader and whose read is audited below;
      // fuzz-derived and bucketed for everybody else. See DISTANCE_BUCKET_M for why the
      // ordinary caller's number is measured to the published position rather than merely
      // rounded off the exact one.
      distanceMeters: isLead ? shortestDistance : coarsen(shortestPublishedDistance),
      // A lead gets the live fix's age; everybody else gets nothing from it.
      //
      // `positionSource` is a single bit — is this named volunteer publishing right now — and
      // `positionAgeMs` sharpens it to the millisecond. Together they let any dispatcher probe
      // the liveness of a colleague they have named, without publishing anything themselves,
      // which is precisely the asymmetry the symmetric opt-out promise rules out. The
      // dispatcher does not need either number: they need to know somebody is on the way.
      positionSource: isLead ? winner!.positionSource : 'unknown',
      positionAgeMs: isLead ? winner!.ageMs : null,
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
      // `escalatedAt` clears with the rest of them.
      //
      // The sweep finds a stale ticket with `{ status: DISPATCHED, escalatedAt: null }`, so a
      // ticket that escalated once, was reassigned, and was then ignored all over again could
      // never escalate a second time — the field it is filtered on still held the first
      // escalation's timestamp. Reassignment exists precisely because the first responder did
      // not come; leaving the ticket permanently unable to shout about the second one is the
      // opposite of what it is for.
      set: {
        assignedVolunteerId: null,
        dispatchedAt: null,
        acknowledgedAt: null,
        onSceneAt: null,
        escalatedAt: null,
      },
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
  public static async resolveTicket(
    ticketId: string,
    volunteerId: string,
    actorRole?: string
  ): Promise<ISOSTicket> {
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
    //
    // What this does NOT close, said plainly: one person holding two accounts. Somebody with a
    // hacker badge and a volunteer badge can raise a ticket on one and collect on the other,
    // because these are two different account ids and nothing here links them to a human.
    // Closing it properly needs identity linking the event does not have — a badge and an SSO
    // login are not tied to each other — and every heuristic substitute (same device, same
    // address, same name) refuses honest people to catch a rare dishonest one.
    //
    // It is bounded rather than open: the bounty is drawn from the raiser's daily budget, so
    // the trade costs them exactly what it earns the other account, and both halves leave a
    // row in `bountyLedger` and `karmaLedger` against a timestamp. It is auditable after the
    // fact, which for a thirty-six hour event with a leaderboard is the proportionate answer.
    if (ticket.createdById && sameId(ticket.createdById, volunteerId)) {
      throw ApiError.forbidden('You cannot resolve a ticket you raised yourself.');
    }

    // Assignee-bound once somebody has been sent: a ticket that is on its way to a named
    // responder pays that responder. An OPEN ticket is claimed by whoever resolves it first.
    //
    // A lead is exempt, as they are for acknowledge, on-scene, reassign and cancel. Without
    // that exemption the lifecycle had a dead end: `transition()` lets a lead acknowledge a
    // ticket and mark themselves on-scene, and then this refused to let them close it — so a
    // lead who walked to a call could drive it to ON_SCENE and strand it there, with the only
    // way out being to reassign it away from themselves. An end-to-end run walked into
    // exactly that: acknowledge 200, on-scene 200, resolve 403.
    //
    // Being *allowed* to close it is not the same as being paid for it: the bounty follows the
    // assignment, and a lead closing a call on the dispatched volunteer's behalf pays that
    // volunteer. See `earnerId` further down, which is where that is decided.
    const claimed = observed !== SOSTicketStatus.OPEN;
    if (claimed && !sameId(ticket.assignedVolunteerId, volunteerId) && !isLeadRole(actorRole)) {
      throw ApiError.forbidden('Only the dispatched volunteer or a lead may resolve this ticket.');
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
    // The bounty follows the WORK, not the click.
    //
    // A lead may resolve a ticket on behalf of the volunteer it was dispatched to — somebody
    // has to close a call when the responder's phone is dead — and the payout named the
    // caller, so the lead collected the responder's bounty and the responder got nothing.
    // Silently, and in favour of the person with the power to do it, which is the worst
    // direction for a mistake like this to point.
    //
    // The earner is the assignee when there is one, and otherwise whoever resolved an
    // unclaimed ticket, which is the case the OPEN path is for.
    const earnerId = resolved.assignedVolunteerId ? String(resolved.assignedVolunteerId) : volunteerId;

    await Volunteer.updateOne({ _id: new Types.ObjectId(earnerId) }, { $addToSet: { badges: 'FIRST_RESPONDER' } });
    // A zero bounty pays nothing, and asking to award nothing is an error rather than a no-op.
    //
    // `awardKarma` refuses a non-positive amount on purpose — a caller who computes zero has
    // almost always computed it by mistake — so an unrewarded ticket has to be handled here
    // instead of there. It still resolves, and the responder still gets the badge below: the
    // work was done whether or not anybody was able to attach a reward to it.
    // What was actually granted, not what was asked for. The daily SOS cap can clamp this
    // to less than the bounty (and to zero once it is spent), and the broadcast below used
    // to report the bounty regardless — so a responder past their cap was told they had
    // earned 150 while their balance did not move. Every other payout in the system
    // propagates the granted figure; this one did not, and a wire that disagrees with the
    // ledger is how a support queue fills up on the night.
    let grantedKarma = 0;
    if (resolved.karmaBounty > 0) {
      const payout = await KarmaService.awardKarma(earnerId, resolved.karmaBounty, KarmaSource.SOS, {
        ticketId: String(resolved._id),
        // Who closed it, when that is not who earned it. A lead closing on somebody's behalf
        // is a normal thing to do and the ledger should say so.
        ...(earnerId === volunteerId ? {} : { resolvedBy: volunteerId }),
      });
      grantedKarma = payout.awarded;
    }
    const vol = await Volunteer.findById(earnerId);

    // Recompute prestige tier from the new balance (single follow-up write; karma itself is already atomic).
    if (vol) {
      const tier = computePrestigeTier(vol.karmaPoints);
      if (tier !== vol.prestigeTier) {
        await Volunteer.updateOne({ _id: vol._id }, { $set: { prestigeTier: tier } });
      }
    }

    domainEvents.emit('sos.resolved', {
      ticketId: String(resolved._id),
      // The person the quest economy should credit is the one who did the work, which is the
      // same one the bounty went to. A lead closing a call on somebody's behalf must not
      // advance the lead's quests either.
      resolverId: earnerId,
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
      // The earner, not the actor. `vol`, `karmaAwarded` and `totalKarma` below are all read
      // from `earnerId`; this one field was the caller. When a lead closes a ticket on the
      // dispatched responder's behalf the two differ, and the frame then said "this id" with
      // somebody else's name and somebody else's balance — so the lead's own client saw its
      // own id and wrote the responder's karma total over its own header.
      volunteerId: earnerId,
      volunteerName: vol ? vol.name : 'Volunteer',
      karmaAwarded: grantedKarma,
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
   * The ticket list, redacted for anybody who is not a lead.
   *
   * The `sos` SSE channel is careful about this: `redactSos` withholds coordinates, the
   * table text and the hacker's name from a non-lead volunteer, because a distress call
   * says where a specific person is and what is wrong with them. This route returned the
   * raw documents to every volunteer-kind caller, for every ticket ever raised — so the
   * redaction on the wire was undone by one REST call, and the two could not both be the
   * policy. An end-to-end run against a live server confirmed it: an ordinary volunteer
   * read `{"coordinates":{"latitude":40.1138,...},"hackerName":...,"tableLocation":...}`.
   *
   * A lead sees everything, as before; the ticket's own parties get the full copy through
   * the targeted `me` channel, which is unchanged.
   */
  public static async listTickets(
    status?: SOSTicketStatus,
    viewer?: { id?: string; role?: string; source?: string }
  ): Promise<Array<ISOSTicket | Record<string, unknown>>> {
    const query = status ? { status } : {};
    const tickets = await SOSTicket.find(query)
      .populate('assignedVolunteerId', 'name role')
      .sort({ createdAt: -1 });
    if (isProvenLead(viewer)) return tickets;
    return tickets.map((t) => {
      // The parties to a ticket keep their own copy whole: the person who raised it, and
      // whoever has been sent to them. Redacting those would hide the address from the one
      // volunteer who has to walk to it.
      //
      // `source === 'session'`, for the same reason `isProvenLead` needs it, and this is the
      // hole that fix left open. Being a party is decided by an id, and in `legacy` mode an
      // id is claimed rather than proved while `GET /volunteers` hands account ids to
      // anonymous callers. So `?volunteerId=<any public id>` matched `createdById` and
      // returned that person's ticket whole — coordinates, table text, hacker name,
      // description, medical category — to a caller with no credential. Tightening only the
      // lead path moved the disclosure one branch down rather than closing it; a claimed
      // identity now gets the redacted shape like every other unproven caller.
      const isParty =
        viewer?.source === 'session' &&
        !!viewer.id &&
        (sameId(t.createdById, viewer.id) || sameId(t.assignedVolunteerId, viewer.id));
      if (isParty) return t;
      return redactedTicket(t);
    });
  }
}

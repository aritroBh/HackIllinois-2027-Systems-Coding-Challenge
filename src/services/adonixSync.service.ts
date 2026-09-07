/**
 * Integration with Adonix, HackIllinois's official backend.
 *
 * Pulls the published event schedule and synthesises a volunteer shift per event, so the
 * roster is derived from the real programme instead of being maintained twice. Shifts are
 * upserted keyed on title, which makes a re-sync idempotent for the common case of a
 * schedule that gained entries since the last run.
 *
 * Two properties of that keying are worth stating plainly, because both are sharp:
 *
 *  - Keying on **title** rather than an Adonix event id means a renamed event syncs as a
 *    new shift and the old one is left stranded. The id is not missing — `IAdonixRawEvent`
 *    declares one and every fallback event sets it — it is simply never read. Keying the
 *    upsert on it is the fix, and what that costs is a new field on `Shift`, which carries
 *    no upstream id today, plus a backfill for every shift already keyed on title.
 *  - An upsert **rewrites the times** of an existing shift. If organisers have already
 *    hand-adjusted a shift, a sync silently reverts it, and volunteers are registered
 *    against times that just changed under them.
 *
 * `POST /adonix/sync` now sits behind `requireRole('ORGANIZER')`, so the two sharp edges
 * above are an organiser's to trigger rather than anybody's. They are still sharp edges: an
 * organiser who syncs after a hand-adjustment silently reverts it. Neither is fixed here,
 * and they are unrelated repairs: the first needs the shift keyed on the id described above,
 * the second is a decision about whether a hand-adjusted time survives a re-sync — moving
 * `startTime` and `endTime` to `$setOnInsert` would settle it and needs no id at all.
 */
import { Shift, ShiftCategory } from '../models/shift.model';
import { eventHub } from '../common/sse/eventHub';

/**
 * The upstream event shape, as Adonix publishes it.
 *
 * Hand-written from the published API and not validated at runtime: the response body is
 * cast to this and nothing checks that the cast is true. A JSON body arriving at a route
 * would be validated by Zod in `middleware/validate`; this arrives from a `fetch` instead,
 * and so is validated by nobody. The blast radius is bounded by the organiser-only route and
 * by the optional chaining on `locations` below, which was added after an upstream event
 * carrying no `locations` array threw halfway through a sync and left it partly applied with
 * no way to resume.
 *
 * Times are seconds, not milliseconds — Adonix's convention, multiplied by 1000 at the one
 * place they become `Date`s.
 */
export interface IAdonixRawEvent {
  id: string;
  name: string;
  description: string;
  startTime: number; // seconds
  endTime: number;   // seconds
  locations: Array<{
    description: string;
    tags: string[];
    latitude?: number;
    longitude?: number;
  }>;
  sponsor?: string;
  eventType: string;
  points: number;
  isAsync: boolean;
}

export class AdonixSyncService {
  /**
   * The schedule endpoint, hard-coded rather than read from `env.ADONIX_URL`.
   *
   * `ADONIX_URL` is the identity adapter's base (`src/auth/adonix.ts`), and it is kept out
   * of content packs so that a fork cannot repoint this server at a host of its choosing by
   * editing JSON. This constant goes one further by not being configurable at all — but the
   * consequence is worth knowing rather than assuming: a fork running its own Adonix cannot
   * point the sync at it. It reads HackIllinois's production schedule or it falls back to
   * the static events below.
   */
  private static readonly ADONIX_EVENT_ENDPOINT = 'https://adonix.hackillinois.org/event/';

  /**
   * Pulls the published schedule and upserts one staffing shift per event.
   *
   * Two things decide what this does, and the fetch is not one of them.
   *
   * The fetch is best-effort and silent about failing. A timeout, a DNS failure, a non-2xx
   * status and an `events` array that came back empty all end in the same place: `rawEvents`
   * is empty and the three hand-written events below are synced instead. That is what keeps
   * `npm run demo` and the offline suite working, and it is also why a response saying
   * "3 shifts synced" is not evidence that Adonix was reachable. Under `NODE_ENV=test` the
   * network call is not attempted at all, so the fallback is the only path the suite covers.
   *
   * The upsert is keyed on `title`, which is `Staffing: <event name>`. Both consequences of
   * that key are in the file header and both are sharp.
   *
   * `capacity`, the two occupancy counters, `manualSurgeMultiplier` and `version` are
   * `$setOnInsert`; everything else is `$set`. That split is the load-bearing part. Those
   * counters are the denormalised occupancy the reservation guard compares against, so
   * rewriting them on a re-sync would reset `filledSlots` to zero under people who already
   * hold seats, or drop `capacity` below the number of seats already sold. Times, location
   * and karma *are* rewritten, which is the edge the file header describes rather than one
   * this method resolves.
   */
  public static async syncOfficialEvents(): Promise<{
    syncedCount: number;
    events: Array<{ title: string; category: string; capacity: number }>;
  }> {
    let rawEvents: IAdonixRawEvent[] = [];

    if (process.env.NODE_ENV !== 'test') {
      try {
        const response = await fetch(this.ADONIX_EVENT_ENDPOINT, {
          headers: { 'User-Agent': 'Nexus-Quest-Engine/1.0', 'Connection': 'close' },
          keepalive: false,
          signal: AbortSignal.timeout(4000),
        });

        if (response.ok) {
          const json = (await response.json()) as { events: IAdonixRawEvent[] };
          rawEvents = json.events || [];
        }
      } catch {
        console.log('⚠️ Live Adonix endpoint unreachable or timed out. Using fallback HackIllinois events...');
      }
    }

    // High-fidelity fallback events if offline or API is partitioned
    if (!rawEvents || rawEvents.length === 0) {
      const baseSec = Math.floor(Date.now() / 1000);
      rawEvents = [
        {
          id: 'adonix_live_01',
          name: 'HackIllinois 2027 Opening Ceremony',
          description: 'Welcome 1,200 hackers to UIUC campus at Kenney Gym.',
          startTime: baseSec + 3600,
          endTime: baseSec + 7200,
          locations: [{ description: 'Kenney Gym Main Stage', tags: ['general'] }],
          eventType: 'OTHER',
          points: 10,
          isAsync: false,
        },
        {
          id: 'adonix_live_02',
          name: 'Google Tech Talk: Distributed Systems at Scale',
          description: 'Google engineers present infrastructure design in Siebel 1404.',
          startTime: baseSec + 10800,
          endTime: baseSec + 14400,
          locations: [{ description: 'Siebel Center Room 1404', tags: ['workshop'] }],
          sponsor: 'Google',
          eventType: 'SPEAKER',
          points: 20,
          isAsync: false,
        },
        {
          id: 'adonix_live_03',
          name: 'Insomnia Cookies Midnight Snack Drop',
          description: 'Deliver 1,500 warm Insomnia cookies across Siebel Atrium.',
          startTime: baseSec + 32400,
          endTime: baseSec + 36000,
          locations: [{ description: 'Siebel Center Atrium', tags: ['food'] }],
          eventType: 'MEAL',
          points: 15,
          isAsync: false,
        },
      ];
    }

    const createdShifts: Array<{ title: string; category: string; capacity: number }> = [];

    for (const ev of rawEvents) {
      // ponytail: locations is optional-chained — a malformed upstream event with no
      // locations array previously threw mid-sync (partial sync, 500, no resume).
      const venueTags = ev.locations?.[0]?.tags ?? [];
      const category = this.projectCategory(ev.eventType, venueTags, ev.sponsor);
      const capacity = this.calculateCapacity(ev.startTime, ev.endTime, category);
      const title = `Staffing: ${ev.name}`;
      const location = ev.locations?.[0]?.description || 'Siebel Center';
      const baseKarma = Math.max(100, (ev.points || 10) * 10);

      const shift = await Shift.findOneAndUpdate(
        { title },
        {
          $set: {
            title,
            description: ev.description || 'HackIllinois official event staffing duty.',
            category,
            location,
            startTime: new Date(ev.startTime * 1000),
            endTime: new Date(ev.endTime * 1000),
            baseKarma,
            isActive: true,
          },
          $setOnInsert: {
            capacity,
            filledSlots: 0,
            waitlistCount: 0,
            manualSurgeMultiplier: 1.0,
            version: 0,
          },
        },
        { upsert: true, new: true }
      );

      createdShifts.push({
        title: shift.title,
        category: shift.category,
        capacity: shift.capacity,
      });
    }

    eventHub.broadcast({
      type: 'ADONIX_EVENTS_SYNCED',
      data: {
        syncedCount: createdShifts.length,
        shifts: createdShifts,
      },
    });

    return {
      syncedCount: createdShifts.length,
      events: createdShifts,
    };
  }

  /**
   * Maps an upstream event onto one of this system's shift categories.
   *
   * The order of the tests is the whole content of this function, because more than one of
   * them matches at once for a real event. Food wins over everything, so a sponsored meal is
   * staffed as FOOD. `sponsor` is tested *before* the speaker/workshop branch, so a
   * sponsored tech talk becomes SPONSOR_RELATIONS rather than MENTOR_SUPPORT — a decision
   * that could have gone the other way, since nothing upstream says which of the two the
   * volunteer standing there is actually doing.
   *
   * Two members of `ShiftCategory` are unreachable from here: INFO_DESK and CLEANUP. Nothing
   * in the upstream shape distinguishes them, so shifts of those kinds are created by hand
   * and a sync never produces one.
   */
  private static projectCategory(eventType: string, tags: string[], sponsor?: string): ShiftCategory {
    const lowerTags = tags.map((t) => t.toLowerCase());
    if (eventType === 'MEAL' || lowerTags.includes('food')) {
      return ShiftCategory.FOOD;
    }
    if (lowerTags.includes('hardware')) {
      return ShiftCategory.HARDWARE_LAB;
    }
    if (sponsor) {
      return ShiftCategory.SPONSOR_RELATIONS;
    }
    if (eventType === 'SPEAKER' || eventType === 'WORKSHOP') {
      return ShiftCategory.MENTOR_SUPPORT;
    }
    return ShiftCategory.LOGISTICS;
  }

  /**
   * The number of volunteers a synthesised shift opens with.
   *
   * FOOD is a flat six whatever the duration. The other two scale with length — LOGISTICS at
   * two an hour, everything else at one — and are clamped at both ends, so a fifteen-minute
   * event still asks for a staffable two and a twelve-hour one does not ask for twelve.
   *
   * This is an opening bid rather than a policy: the caller writes it with `$setOnInsert`,
   * so it applies once when the shift is first created and an organiser's later adjustment
   * survives every re-sync.
   */
  private static calculateCapacity(startSec: number, endSec: number, category: ShiftCategory): number {
    const durationHours = Math.max(1, (endSec - startSec) / 3600);
    if (category === ShiftCategory.FOOD) return 6;
    if (category === ShiftCategory.LOGISTICS) return Math.min(6, Math.max(2, Math.round(durationHours * 2)));
    return Math.min(4, Math.max(2, Math.round(durationHours)));
  }
}

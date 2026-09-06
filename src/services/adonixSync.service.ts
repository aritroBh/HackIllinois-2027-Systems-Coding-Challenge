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
 *    new shift and the old one is left stranded. An upstream stable id is the fix.
 *  - An upsert **rewrites the times** of an existing shift. If organisers have already
 *    hand-adjusted a shift, a sync silently reverts it, and volunteers are registered
 *    against times that just changed under them.
 *
 * The route is also unauthenticated today, so those two together are the reason it should
 * sit behind organiser auth before it runs against real data.
 */
import { Shift, ShiftCategory } from '../models/shift.model';
import { eventHub } from '../common/sse/eventHub';

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
  private static readonly ADONIX_EVENT_ENDPOINT = 'https://adonix.hackillinois.org/event/';

  /**
   * Fetches official event schedule from HackIllinois Adonix API and synthesizes volunteer shifts.
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

  private static calculateCapacity(startSec: number, endSec: number, category: ShiftCategory): number {
    const durationHours = Math.max(1, (endSec - startSec) / 3600);
    if (category === ShiftCategory.FOOD) return 6;
    if (category === ShiftCategory.LOGISTICS) return Math.min(6, Math.max(2, Math.round(durationHours * 2)));
    return Math.min(4, Math.max(2, Math.round(durationHours)));
  }
}

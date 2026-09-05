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
          headers: { 'User-Agent': 'WaveShift-Nexus-Engine/1.0', 'Connection': 'close' },
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
      const category = this.projectCategory(ev.eventType, ev.locations[0]?.tags || [], ev.sponsor);
      const capacity = this.calculateCapacity(ev.startTime, ev.endTime, category);
      const title = `Staffing: ${ev.name}`;
      const location = ev.locations[0]?.description || 'Siebel Center';
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

import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { SurgePricingEngine } from '../src/common/utils/surgePricing';

describe('Shift Management & Dynamic Surge Pricing', () => {
  it('creates a new shift successfully', async () => {
    const startTime = new Date(Date.now() + 3600000).toISOString();
    const endTime = new Date(Date.now() + 7200000).toISOString();

    const res = await request(app)
      .post('/api/v1/shifts')
      .send({
        title: 'Opening Ceremony Check-In',
        description: 'Distribute badge packets and welcome hackers.',
        category: ShiftCategory.INFO_DESK,
        location: 'Kenney Gym Main Entrance',
        startTime,
        endTime,
        capacity: 4,
        requiredSkills: ['CUSTOMER_SERVICE'],
        baseKarma: 100,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('Opening Ceremony Check-In');
    expect(res.body.data.capacity).toBe(4);
    expect(res.body.data.filledSlots).toBe(0);
  });

  it('rejects shift creation with invalid time order (startTime after endTime)', async () => {
    const startTime = new Date(Date.now() + 7200000).toISOString();
    const endTime = new Date(Date.now() + 3600000).toISOString();

    const res = await request(app)
      .post('/api/v1/shifts')
      .send({
        title: 'Broken Shift',
        description: 'Should fail validation',
        category: ShiftCategory.LOGISTICS,
        location: 'Siebel Center',
        startTime,
        endTime,
        capacity: 2,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('calculates dynamic surge pricing with circadian and scarcity multipliers', () => {
    const nightTime = new Date('2027-02-28T03:30:00Z'); // 3:30 AM
    const shiftStart = new Date('2027-02-28T04:00:00Z'); // 30 minutes away

    const surge = SurgePricingEngine.calculate({
      baseKarma: 200,
      capacity: 5,
      filledSlots: 1, // 80% deficit!
      startTime: shiftStart,
      currentTime: nightTime,
      manualMultiplier: 1.0,
    });

    expect(surge.surgeMultiplier).toBeGreaterThan(2.0);
    expect(surge.karmaAward).toBeGreaterThan(400);
    expect(surge.isSurgeActive).toBe(true);
  });

  it('lists shifts with enriched surge multipliers', async () => {
    await Shift.create({
      title: 'Active Surge Shift',
      description: 'Emergency Red Bull restock',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Basement',
      startTime: new Date(Date.now() + 1800000),
      endTime: new Date(Date.now() + 5400000),
      capacity: 3,
      filledSlots: 0,
      baseKarma: 150,
      manualSurgeMultiplier: 2.0,
    });

    const res = await request(app).get('/api/v1/shifts');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].surge).toBeDefined();
  });
});

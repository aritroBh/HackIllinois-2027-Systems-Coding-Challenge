import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { DynamicQrTokenEngine } from '../src/common/utils/crypto';

describe('Dynamic HMAC QR Attendance Verification & Anti-Fraud', () => {
  beforeEach(() => {
    DynamicQrTokenEngine.clearNonceCache();
  });

  it('generates, verifies a dynamic QR token, and prevents replay attacks', async () => {
    const vol = await Volunteer.create({
      name: 'Morgan Freeman',
      email: 'morgan@illinois.edu',
      karmaPoints: 100,
    });

    const shift = await Shift.create({
      title: 'Swag Station',
      description: 'Swag distribution',
      category: ShiftCategory.INFO_DESK,
      location: 'Kenney Gym',
      startTime: new Date(Date.now() - 3600000), // Started 1h ago
      endTime: new Date(Date.now() + 3600000),
      capacity: 2,
      baseKarma: 150,
    });

    await Registration.create({
      shiftId: shift._id,
      volunteerId: vol._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'checkin_reg_1',
    });

    // 1. Generate dynamic token
    const tokenRes = await request(app)
      .post('/api/v1/attendance/token')
      .send({ volunteerId: vol._id.toString(), shiftId: shift._id.toString() });

    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.data.token).toBeDefined();
    const token = tokenRes.body.data.token;

    // 2. Scan and verify token
    const verifyRes = await request(app)
      .post('/api/v1/attendance/verify')
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.verification.valid).toBe(true);
    const checkInId = verifyRes.body.data.checkIn._id;

    // Verify registration status updated to CHECKED_IN
    const updatedReg = await Registration.findOne({ shiftId: shift._id, volunteerId: vol._id });
    expect(updatedReg?.status).toBe(RegistrationStatus.CHECKED_IN);

    // 3. Attempt replay attack (scanning the exact same token again)
    const replayRes = await request(app)
      .post('/api/v1/attendance/verify')
      .send({ token });

    expect(replayRes.status).toBe(409);
    expect(replayRes.body.error).toBe('REPLAY_ATTACK_DETECTED');

    // 4. Check out and verify Karma points awarded
    const checkOutRes = await request(app).post(`/api/v1/attendance/${checkInId}/checkout`);
    expect(checkOutRes.status).toBe(200);
    expect(checkOutRes.body.data.karmaAwarded).toBeGreaterThan(0);

    // Verify volunteer points updated
    const updatedVol = await Volunteer.findById(vol._id);
    expect(updatedVol?.karmaPoints).toBeGreaterThan(100);
  });

  it('rejects expired dynamic QR tokens (>60s old)', () => {
    const now = Date.now();
    // Generate token from 90 seconds ago (3 time slices ago)
    const pastTimestamp = now - 90000;
    const expiredToken = DynamicQrTokenEngine.generateToken('vol_test', 'shift_test', pastTimestamp);

    const result = DynamicQrTokenEngine.verifyToken(expiredToken, 1, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('EXPIRED');
  });
});

/**
 * Shift routes — `/api/v1/shifts`.
 *
 * Each entry pairs a path with its Zod schema and a controller method. `validate(...)`
 * runs first and rejects malformed input with a 400 before any handler executes, so
 * controllers below can treat their inputs as well-formed.
 *
 * `DELETE` is a soft delete (flips `isActive`); it does not remove the document.
 */
import { Router } from 'express';
import { ShiftController } from '../../controllers/shift.controller';
import { validate } from '../../middleware/validate';
import { requireRole, requireSession } from '../../middleware/identity';
import {
  createShiftSchema,
  updateShiftSchema,
  getShiftParamsSchema,
  listShiftsQuerySchema,
} from '../../schemas/shift.schema';

export const shiftRouter = Router();

// Shift definitions are an organiser's job (leads may edit; legacy anonymous callers pass).
shiftRouter.post('/', requireRole('SHIFT_LEAD'), validate(createShiftSchema), ShiftController.createShift);
shiftRouter.get('/', validate(listShiftsQuerySchema), ShiftController.listShifts);
shiftRouter.get('/:id', validate(getShiftParamsSchema), ShiftController.getShiftById);

/**
 * The lead's roster (plan §A7): who is signed up, who has arrived, and — for anyone
 * publishing presence — how fresh their fix is and roughly where they are.
 *
 * The distance and freshness *buckets* are still a disclosure about named people, so the
 * view is audited once (never once per row) and needs a real session, not a legacy claim.
 */
shiftRouter.get('/:id/roster', requireSession, requireRole('SHIFT_LEAD'), validate(getShiftParamsSchema), ShiftController.getRoster);
shiftRouter.patch('/:id', requireRole('SHIFT_LEAD'), validate(updateShiftSchema), ShiftController.updateShift);
shiftRouter.delete('/:id', requireRole('ORGANIZER'), validate(getShiftParamsSchema), ShiftController.deleteShift);

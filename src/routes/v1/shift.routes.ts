import { Router } from 'express';
import { ShiftController } from '../../controllers/shift.controller';
import { validate } from '../../middleware/validate';
import {
  createShiftSchema,
  updateShiftSchema,
  getShiftParamsSchema,
  listShiftsQuerySchema,
} from '../../schemas/shift.schema';

export const shiftRouter = Router();

shiftRouter.post('/', validate(createShiftSchema), ShiftController.createShift);
shiftRouter.get('/', validate(listShiftsQuerySchema), ShiftController.listShifts);
shiftRouter.get('/:id', validate(getShiftParamsSchema), ShiftController.getShiftById);
shiftRouter.patch('/:id', validate(updateShiftSchema), ShiftController.updateShift);
shiftRouter.delete('/:id', validate(getShiftParamsSchema), ShiftController.deleteShift);

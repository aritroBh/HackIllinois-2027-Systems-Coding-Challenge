import { Router } from 'express';
import { CheckInController } from '../../controllers/checkin.controller';
import { validate } from '../../middleware/validate';
import {
  generateQrTokenSchema,
  verifyCheckInSchema,
  checkOutSchema,
} from '../../schemas/checkin.schema';

export const checkinRouter = Router();

checkinRouter.post('/token', validate(generateQrTokenSchema), CheckInController.generateToken);
checkinRouter.post('/verify', validate(verifyCheckInSchema), CheckInController.verifyCheckIn);
checkinRouter.post('/:id/checkout', validate(checkOutSchema), CheckInController.checkOut);

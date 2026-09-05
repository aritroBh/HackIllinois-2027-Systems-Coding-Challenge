import { Router } from 'express';
import { RegistrationController } from '../../controllers/registration.controller';
import { validate } from '../../middleware/validate';
import {
  reserveShiftSchema,
  cancelRegistrationSchema,
  listRegistrationsQuerySchema,
} from '../../schemas/registration.schema';

export const registrationRouter = Router();

registrationRouter.post('/', validate(reserveShiftSchema), RegistrationController.reserveShift);
registrationRouter.delete('/:id', validate(cancelRegistrationSchema), RegistrationController.cancelRegistration);
registrationRouter.get('/', validate(listRegistrationsQuerySchema), RegistrationController.listRegistrations);

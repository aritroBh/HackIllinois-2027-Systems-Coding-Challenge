import { Router } from 'express';
import { VolunteerController } from '../../controllers/volunteer.controller';
import { validate } from '../../middleware/validate';
import { createVolunteerSchema, getVolunteerParamsSchema } from '../../schemas/volunteer.schema';

export const volunteerRouter = Router();

volunteerRouter.post('/', validate(createVolunteerSchema), VolunteerController.createVolunteer);
volunteerRouter.get('/', VolunteerController.listVolunteers);
volunteerRouter.get('/:id', validate(getVolunteerParamsSchema), VolunteerController.getVolunteerById);

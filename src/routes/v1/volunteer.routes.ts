/**
 * Volunteer routes — `/api/v1/volunteers`.
 *
 * Reads are open by design so the live dashboard works without credentials; note that
 * the list endpoint is unprojected and unpaginated, so it should gain both before it
 * carries real attendee data.
 */
import { Router } from 'express';
import { VolunteerController } from '../../controllers/volunteer.controller';
import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/identity';
import { createVolunteerSchema, getVolunteerParamsSchema } from '../../schemas/volunteer.schema';

export const volunteerRouter = Router();

// Creating accounts is organiser work (legacy anonymous callers pass): otherwise anyone could
// mint accounts to multiply their per-account rate budget.
volunteerRouter.post('/', requireRole('ORGANIZER'), validate(createVolunteerSchema), VolunteerController.createVolunteer);
volunteerRouter.get('/', VolunteerController.listVolunteers);
volunteerRouter.get('/:id', validate(getVolunteerParamsSchema), VolunteerController.getVolunteerById);

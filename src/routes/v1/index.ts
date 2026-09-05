import { Router } from 'express';
import { shiftRouter } from './shift.routes';
import { volunteerRouter } from './volunteer.routes';
import { registrationRouter } from './registration.routes';
import { swapRouter } from './swap.routes';
import { checkinRouter } from './checkin.routes';
import { statsRouter } from './stats.routes';
import { sosRouter } from './sos.routes';
import { adonixRouter } from './adonix.routes';
import { pokeShiftRouter } from './pokestop.routes';

export const v1Router = Router();

v1Router.use('/shifts', shiftRouter);
v1Router.use('/volunteers', volunteerRouter);
v1Router.use('/registrations', registrationRouter);
v1Router.use('/swaps', swapRouter);
v1Router.use('/attendance', checkinRouter);
v1Router.use('/stats', statsRouter);
v1Router.use('/sos', sosRouter);
v1Router.use('/adonix', adonixRouter);
v1Router.use('/pokeshift', pokeShiftRouter);



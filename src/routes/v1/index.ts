/**
 * API v1 router composition.
 *
 * Every resource is mounted under an explicit path prefix here, which keeps the URL
 * surface visible in one file rather than scattered across route modules. The `/api/v1`
 * prefix itself is applied in `app.ts`, together with the rate limiter and the mutation
 * auth guard — so everything mounted below inherits both automatically.
 *
 * Routes stay declarative: a path, its validation schema, and a controller method. Any
 * file in this directory that starts making decisions belongs in a service instead.
 */
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
import { authRouter } from './auth.routes';
import { meRouter } from './me.routes';
import { contentRouter } from './content.routes';
import { presenceRouter } from './presence.routes';
import { avatarRouter } from './avatar.routes';
import { announcementRouter } from './announcement.routes';
import { gameRouter } from './game.routes';
import { mountPlugins } from '../../plugins';

export const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/content', contentRouter);
v1Router.use('/presence', presenceRouter);
v1Router.use('/avatars', avatarRouter);
v1Router.use('/announcements', announcementRouter);
v1Router.use('/me', meRouter);
v1Router.use('/shifts', shiftRouter);
v1Router.use('/volunteers', volunteerRouter);
v1Router.use('/registrations', registrationRouter);
v1Router.use('/swaps', swapRouter);
v1Router.use('/attendance', checkinRouter);
v1Router.use('/stats', statsRouter);
v1Router.use('/sos', sosRouter);
v1Router.use('/adonix', adonixRouter);
v1Router.use('/pokeshift', pokeShiftRouter);
v1Router.use('/game', gameRouter);

// Plugins last, so a plugin can never shadow a core route by registering the same path.
mountPlugins(v1Router);

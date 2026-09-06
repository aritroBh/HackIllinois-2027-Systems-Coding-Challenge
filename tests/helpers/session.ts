/**
 * Signing a supertest agent in, the way a browser does.
 *
 * The session lives only in an HttpOnly cookie and every mutation echoes a CSRF nonce from
 * a second, JS-readable cookie — so a test that wants to exercise a real route has to carry
 * both, and one that forgets the nonce fails with a 403 that looks nothing like the thing it
 * was testing. `request.agent` keeps the cookie jar; this returns the nonce alongside it.
 */
import request from 'supertest';
import { app } from '../../src/app';
import { cookieNames } from '../../src/common/utils/sessionToken';

export function csrfFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = setCookie.find((c) => c.startsWith(`${cookieNames().csrf}=`));
  if (!raw) throw new Error('no csrf cookie on the sign-in response');
  return decodeURIComponent(raw.split(';')[0].split('=')[1]);
}

export async function signIn(accountId: string): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/dev-login').send({ accountId });
  if (res.status !== 200) throw new Error(`dev-login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: csrfFrom(res) };
}

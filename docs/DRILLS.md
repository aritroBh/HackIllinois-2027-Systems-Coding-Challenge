# Abuse drills

Run these against a staging instance before the event, with `AUTH_MODE=required`. Each one is a thing somebody will actually try, and each has a defence that is easy to break by accident. The point of a drill is to confirm the defence still works on the build you are about to run, not to discover it for the first time.

Record the date, the commit, and the outcome. A drill that was not run is not a passing drill.

## 1. The screenshotted QR

Someone photographs a check-in code and posts it in Discord.

Mint a token, wait forty seconds, and present it. Expect a rejection. Present a valid token twice and expect the second to be refused. Present one volunteer's token as another volunteer and expect a refusal.

The defence is a thirty-second window, a single-use nonce cache, and a binding to both the shift and the person. All three matter: drop any one and the screenshot works.

## 2. The spoofed position

Someone reports coordinates from their sofa, or teleports across campus to farm HackStops.

Post positions jumping five hundred metres every two seconds. Expect the samples to be refused and, after three in a row, a sixty-second mute that survives reconnecting. Then post a genuine walking pace, five metres every three seconds, and expect every sample accepted.

The second half is the one that fails silently. A speed gate tuned too tight makes the feature useless for anyone on a bicycle.

## 3. The claimed identity

In `legacy` mode a caller may name themselves with a body field. Confirm that this never unlocks anything that discloses other people.

As an anonymous caller, name a lead's id and request `GET /api/v1/presence`, the avatar review queue, and a shift roster. Expect 401 from all three. Then sign in properly as a lead and expect 200.

## 4. Delegation as impersonation

A shift lead may register a volunteer at the desk. Confirm that is the only thing they may do as someone else.

As a lead, send `onBehalfVolunteerId` naming a victim to a HackStop spin, an SOS resolve, a check-out, and a gym battle. Expect every one of them to act as the lead, never as the victim. Then send it to `POST /registrations` and expect the victim to be registered.

## 5. Adonix down, SMTP down

Stop whatever Adonix points at and load the sign-in screen. Expect the provider to report itself disabled and badge codes to keep working. Unset `SMTP_URL` and expect the magic-link option to disappear rather than to fail on submit.

Badge codes are the adapter with no dependencies. If an outage in someone else's service can stop people signing in, the fallback is not real.

## 6. The venue NAT

A thousand people share four egress addresses. Confirm nobody is locked out by an anti-abuse limit meant for a single attacker.

From one address, open more than eight hundred streams and expect refusals; put that address in `TRUSTED_EGRESS_CIDRS` and expect them to be admitted. Then confirm an authenticated request never counts against an IP bucket by making several hundred from one address as different accounts.

## 7. The avatar

Upload a PNG with an appended archive and expect a rejection. Upload one carrying a metadata chunk and confirm the stored bytes do not contain it. Have three accounts report an approved avatar and confirm it is unpublished immediately and that connected clients drop the texture.

## 8. The brigade

Create a handful of accounts and report the same avatar from each. Expect the reports to be capped per account per hour. This one is a judgement call rather than a pass or fail: decide before the event whether three reporters is the right threshold for your crowd.

## 9. Restart under load

With the presence soak running, restart the server. Expect clients to reconnect with jittered backoff, positions to be re-sent within five seconds, and mutes to survive because they live in the database rather than in memory. Confirm no ticket, registration or claim was lost.

## 10. The scale soak

The M4b gate, run twice: once with the load generator's addresses in `TRUSTED_EGRESS_CIDRS` and once without.

```sh
npm run bench:presence -- --clients 1200 --devices 2 --seconds 120 --storm 10
```

Expect a tick p95 under thirty milliseconds, outbound under one megabyte a second, the cluster-only fallback never triggered, and every reconnecting account keeping its other connection.

# Abuse drills

Run these against a staging instance before the event, with `AUTH_MODE=required`. Each one is a thing somebody will actually try, and each has a defence that is easy to break by accident. The point of a drill is to confirm the defence still works on the build you are about to run, not to discover it for the first time.

Record the date, the commit, and the outcome. A drill that was not run is not a passing drill.

## 1. The screenshotted QR

Someone photographs a check-in code and posts it in Discord.

Mint a token, wait seventy seconds, and present it. Expect a rejection. Present a valid token twice and expect the second to be refused. Present one volunteer's token as another volunteer and expect a refusal.

Seventy rather than forty, because the window is wider than the rotation. Tokens are bound to a thirty-second slice and verification accepts a slice within one of the current one, so a token minted at the top of its slice is still good sixty seconds later and one minted at the bottom dies at thirty. Forty seconds is inside that spread: the drill would pass or fail depending on when in the second you happened to mint, which is the worst possible property for a check meant to tell you the defence still works.

The defence is that bounded window, a single-use nonce cache backed by a unique index on `CheckIn.nonce`, and a binding to both the shift and the person. All three matter: drop any one and the screenshot works.

## 2. The spoofed position

Someone reports coordinates from their sofa, or teleports across campus to farm HackStops.

Post positions jumping five hundred metres every two seconds. Expect the samples to be refused and, after three in a row, a sixty-second mute that survives reconnecting. Then post a genuine walking pace, five metres every three seconds, and expect every sample accepted.

The second half is the one that fails silently. A speed gate tuned too tight makes the feature useless for anyone on a bicycle.

## 3. The claimed identity

In `legacy` mode a caller may name themselves with a body field. Confirm that this never unlocks anything that discloses other people.

As an anonymous caller, name a lead's id and request `GET /api/v1/presence`, the avatar review queue, and a shift roster. Expect 401 from all three. Then sign in properly as a lead and expect 200.

## 4. Delegation as impersonation

A shift lead may register a volunteer at the desk, and cancel that registration again. Confirm those two are the only things they may do as someone else.

As a lead, send `onBehalfVolunteerId` naming a victim to a HackStop spin, an SOS resolve, a check-out, and a gym battle. Expect every one of them to act as the lead, never as the victim. Then send it to `POST /registrations` and expect the victim to be registered, and to `DELETE /registrations/:id` and expect the victim's registration cancelled — both of those opt in through `resolveOnBehalf`, and nothing else in the tree calls it.

## 5. Adonix down, SMTP down

Stop whatever Adonix points at and load the sign-in screen. Expect badge codes to keep working, and expect the Adonix button to still be there: `GET /auth/providers` reports `adonix` enabled from the `ADONIX_ENABLED` flag alone and never probes the upstream, so an outage shows up as a failed exchange four seconds after somebody presses the button, not as a provider that withdrew itself. That is the honest expectation, and the drill is confirming the blast radius rather than a graceful degrade: nothing about the outage may reach the badge-code path. If you want the button gone during an outage, unset `ADONIX_ENABLED` — there is nothing automatic to wait for.

Then unset `SMTP_URL` and expect the magic-link option to disappear rather than to fail on submit. This one only holds with `NODE_ENV=production`, because outside production the console mailer counts as a mailer and the option stays offered with no SMTP configured. A staging box running as `development` will fail this drill for a reason that is not a defect.

Badge codes are the adapter with no dependencies. If an outage in someone else's service can stop people signing in, the fallback is not real.

## 6. The venue NAT

A thousand people share four egress addresses. Confirm nobody is locked out by an anti-abuse limit meant for a single attacker.

From one address, open more than three thousand signed-in streams — `STREAM_PER_IP`, and two connections per account, so more than fifteen hundred accounts — and expect refusals; put that address in `TRUSTED_EGRESS_CIDRS` and expect them to be admitted. Then confirm an authenticated request never counts against an IP bucket by making several hundred from one address as different accounts.

Sign the streams in. The anonymous ceilings — the eight-hundred-slot `STREAM_ANON_SLOTS` pool and a cap of twenty anonymous streams per address — are checked before the trusted-egress test and are never lifted by it, so an anonymous run from one address stops at twenty and adding the range changes nothing. That is deliberate rather than an oversight, and it is the answer to give an operator who reports the venue being throttled after listing its ranges: a stream with no account behind it has nothing else to bound it by, so the list cannot help them.

## 7. The avatar

Upload a PNG with an appended archive and expect a rejection. Upload one carrying a metadata chunk and confirm the stored bytes do not contain it. Have three accounts report an approved avatar and confirm it is unpublished immediately and that connected clients drop the texture.

## 8. The brigade

Create a handful of accounts and report the same avatar from each. Expect the reports to be capped per account per hour. This one is a judgement call rather than a pass or fail: decide before the event whether three reporters is the right threshold for your crowd.

## 9. Restart under load

With the presence soak running, restart the server. Expect clients to reconnect with jittered backoff, positions to be re-sent within five seconds, and mutes to survive because they live in the database rather than in memory. Confirm no ticket, registration or claim was lost.

## 10. The scale soak

The M4b gate, run twice: once with the load generator's addresses in `TRUSTED_EGRESS_CIDRS` and once without.

```sh
npm run bench:presence -- --clients 5000 --devices 2 --seconds 120 --storm 10
```

Expect a tick p95 under thirty milliseconds, outbound under one megabyte a second, the cluster-only fallback never triggered, and every reconnecting account keeping its other connection.

# Security policy

This system holds a volunteer roster, live locations of people on a campus, and the SOS
queue that gets help to a hacker who needs it. We take reports about it seriously.

## Reporting

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. That opens a private advisory visible only to the maintainers.

Please do not open a public issue, and please do not post it in a chat channel. If you are
running a fork, replace this section with your own contact route before you deploy it.

Tell us what you did, what happened, and what you expected. A short reproduction beats a
scanner report. If you need to demonstrate against a live event deployment, ask first.

We will acknowledge a report within a few days and tell you what we intend to do about it.
There is no bounty programme. We will credit you in the fix unless you would rather we did
not.

## In scope

Anything that breaks a boundary the system claims to hold:

* Signing in as somebody else, or acting as somebody else: session forgery, claim-code
  weaknesses, CSRF, the SSO trust boundary, role escalation across the lead and organiser
  ranks.
* Forging attendance: QR token forgery, replay, or bypassing the geofence.
* Reading an exact position you should not see, or otherwise defeating the presence privacy
  gates described in [docs/PRESENCE.md](docs/PRESENCE.md).
* Cross-account data disclosure through any API route, including through plugin routes.
* Cross-site scripting or a Content Security Policy bypass in the dashboard, including
  through content-pack or avatar data that reaches the DOM.
* Server-side request forgery, path traversal out of the content pack, or anything that
  makes the server fetch or serve a file it should not.
* Bypassing the rate limits or the stream-slot table in a way that a single client can use
  to deny service to the venue.
* A concurrency or transaction defect that oversells a shift, duplicates karma, or loses an
  SOS ticket.

## Out of scope

* Anything that depends on the demo defaults. `AUTH_MODE=legacy` believes a `volunteerId`
  in the request body, and the committed secrets are placeholders. Production refuses to
  boot in either state, on purpose. A finding that requires them is a finding about the
  demo.
* Denial of service by raw traffic volume against a deployment you do not run.
* Missing hardening headers with no demonstrated impact, and scanner output without one.
* Social engineering of organisers or volunteers.
* Licensing or accuracy problems in third-party map data. Those belong in an issue.

## Supported versions

The `main` branch is what is maintained. Forks are on their own, which is the deal.

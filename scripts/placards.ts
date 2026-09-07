/**
 * The booth placard codes, for the posters that go on the tables.
 *
 * `BoothService.codeFor` has been exported since booths shipped, with a docblock saying it is
 * public "because posters have to be produced from somewhere, and the organiser tooling that
 * prints them should derive them the same way the scanner verifies them rather than keeping a
 * second copy". There was no organiser tooling. Every caller was a test.
 *
 * So the feature was complete and unreachable: booths in the pack, a working scan endpoint, four
 * accurate refusal messages in the client — and no way to obtain the code a sponsor would print,
 * short of deriving the HMAC by hand. This is that tooling, and it exists as much to make the
 * export's justification true as to print anything.
 *
 * The whole point is that it does **not** reimplement the derivation. It calls `codeFor`, which is
 * what `scan` verifies against, so a code from here cannot disagree with the scanner. A second
 * implementation that happened to match today is the shape this repository has spent two days
 * removing from venues, loot tables and geofence radii.
 *
 *   npm run placards                  # every booth in the active pack
 *   npm run placards -- --json        # machine-readable, for a print pipeline
 *   CONTENT_PACK=my-event npm run placards
 *
 * ## The secret is the whole story, so it is printed loudly
 *
 * A code is an HMAC over the booth id under `QR_HMAC_SECRET`. Print placards under one secret and
 * run the event under another and every scan is refused — the posters are on the tables by then,
 * which makes this the one failure here that cannot be fixed at the event.
 *
 * `env.ts` treats the committed example value as *unset* and generates an ephemeral per-boot
 * secret, so copying `.env.example` to `.env` unchanged — the obvious first move for a fork —
 * silently gives codes that change on every restart. This refuses to print in that state rather
 * than handing somebody a sheet of posters that will stop working when the server restarts.
 */
import { BoothService } from '../src/services/booth.service';
import { pack } from '../src/content/loader';
import { env } from '../src/config/env';

/** Booths as the pack declares them, via the same catalogue the scanner reads. */
function booths(): Array<{ id: string; name: string; venue: string }> {
  return BoothService.list().map((booth) => ({ id: booth.id, name: booth.name, venue: booth.venue }));
}

function main(): void {
  const asJson = process.argv.includes('--json');

  /*
   * Refuse to print under a secret that will not survive a restart.
   *
   * The check is on the *resolved* value, not on whether the variable was set, and the first
   * version of this guard got that wrong in a way worth recording: it tested
   * `!process.env.QR_HMAC_SECRET`, which is exactly the case that cannot occur here.
   * `.env` carries the committed example value, so the variable is always set; `env.ts` then
   * compares it against that committed default and *replaces* it with an ephemeral per-boot
   * secret. The variable is present, the effective secret is throwaway, and the guard passed.
   *
   * It printed a sheet of placards on its first run and I only noticed because the codes differed
   * between two runs. A guard written minutes after discussing guards that cannot fire, in the
   * script whose whole purpose is that these codes must not change.
   *
   * `env.QR_HMAC_SECRET` is what `codeFor` actually signs with, so that is what gets checked:
   * an `ephemeral_dev_` value means `env.ts` generated it this boot, and the committed default
   * means production would refuse to start on it anyway.
   */
  const effective = env.QR_HMAC_SECRET;
  const isEphemeral = effective.startsWith('ephemeral_dev_');
  const isCommittedDefault = effective === 'hackillinois_waveshift_secret_key_2027';
  if (isEphemeral || isCommittedDefault) {
    console.error('Refusing to print placards: these codes would not survive a restart.\n');
    console.error(
      isEphemeral
        ? '  QR_HMAC_SECRET resolved to an ephemeral per-boot secret, because the value it was\n' +
          '  given is the committed default that .env.example ships. Copying .env.example to .env\n' +
          '  unchanged lands you here, and the codes change every time the server restarts.'
        : '  QR_HMAC_SECRET is still the committed default from .env.example.'
    );
    console.error('');
    console.error('Codes are an HMAC over the booth id under that secret, so a placard is only');
    console.error('valid for as long as the secret is. The posters are on the tables by then.');
    console.error('');
    console.error('Set the secret the event will actually run under, then re-run:');
    console.error('  QR_HMAC_SECRET=<the deployment secret> npm run placards');
    process.exit(1);
  }

  const rows = booths().map((booth) => ({ ...booth, code: BoothService.codeFor(booth.id) }));

  if (rows.length === 0) {
    console.error(`Content pack "${pack.event.id}" declares no booths (booths.json is absent or empty).`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ pack: pack.event.id, booths: rows }, null, 2));
    return;
  }

  const width = Math.max(...rows.map((r) => r.id.length), 'BOOTH'.length);
  console.log(`\nBooth placards — content pack "${pack.event.id}" (${env.NODE_ENV})\n`);
  console.log(`  ${'BOOTH'.padEnd(width)}  CODE                  VENUE / NAME`);
  for (const row of rows) {
    console.log(`  ${row.id.padEnd(width)}  ${row.code.padEnd(20)}  ${row.venue} — ${row.name}`);
  }
  console.log(`\n${rows.length} placard(s). Print the CODE on each booth's poster.`);
  console.log('These are valid only under the secret they were generated with.\n');
}

main();

/**
 * The attendance QR, proved by reading it back.
 *
 * `public/qr.js` is a hand-written encoder — there is no bundler here, and the token is a live
 * credential that must never be posted to a hosted QR image service, so importing one was not an
 * option. Hand-written means it needs proof, and the only proof that matters for a QR is that an
 * independent decoder can read it.
 *
 * These tests render symbols and decode them with `jsqr`, which shares no code with the encoder.
 *
 * They exist because of a specific bug. The first working version produced symbols of exactly the
 * right size and shape — correct finder patterns, correct timing, correct format bits, data
 * codewords matching a reference encoder byte for byte — and **no decoder would read a single
 * one**. The generator polynomial was built as `prod(a^i * x + 1)` instead of `prod(x + a^i)`:
 * the two multiplications in one line were the wrong way round, so the error-correction bytes
 * were wrong and every decoder rejected the checksum. Nothing about the image looked wrong. Only
 * decoding it found it.
 */
import fs from 'fs';
import path from 'path';
import jsQR from 'jsqr';

/** Load the browser file the way the page does, and hand back its global. */
function loadEncoder(): { encode: (t: string, o?: { mask?: number }) => number[][] } {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'qr.js'), 'utf8');
  const globalObj: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('window', src)(globalObj);
  return globalObj.NexusQR as { encode: (t: string, o?: { mask?: number }) => number[][] };
}

/**
 * Paint a matrix into RGBA pixels with the quiet zone the specification requires.
 *
 * The four-module border is not decoration: without it a decoder has nothing to separate the
 * finder patterns from whatever the symbol is sitting on, and this is one of the two ways a
 * technically-correct symbol still fails to scan.
 */
function rasterise(matrix: number[][], scale = 6, quiet = 4): { data: Uint8ClampedArray; size: number } {
  const size = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix.length; c += 1) {
      if (!matrix[r][c]) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          data[px] = 0; data[px + 1] = 0; data[px + 2] = 0; data[px + 3] = 255;
        }
      }
    }
  }
  return { data, size };
}

const decode = (text: string, opts?: { mask?: number }): string | null => {
  const { encode } = loadEncoder();
  const { data, size } = rasterise(encode(text, opts));
  return jsQR(data, size, size)?.data ?? null;
};

describe('the attendance QR is a QR', () => {
  /** The shape `POST /attendance/token` actually mints: base64url payload, a dot, 64 hex chars. */
  const REAL_TOKEN =
    'MTo2YTllNDVkYWQxZmM4MWI3ODRjNzM3OWM6NmE5ZTQ1ZGJkMWZjODFiNzg0YzczN2E4OjU5NjllMTA2'
    + '.698a147c52b517d18ef17dcbf1c652ec65ca8e5c831e09d3d4b1702398900996';

  it('round-trips the real token shape through an independent decoder', () => {
    expect(decode(REAL_TOKEN)).toBe(REAL_TOKEN);
  });

  it.each([
    ['short', 'HELLO'],
    ['mixed case and punctuation', 'nexus-quest: check in at Siebel'],
    ['a claim URL', 'https://example.com/dashboard/#claim=ABCDEFGHJK'],
    ['200 bytes', 'x'.repeat(200)],
  ])('round-trips %s', (_label, text) => {
    expect(decode(text)).toBe(text);
  });

  /**
   * Every mask has to produce a readable symbol, not just the one the penalty rules happen to
   * pick for a given string. A mask that is wrong in isolation would otherwise sit undetected
   * until some future token scored differently and chose it.
   */
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('round-trips under mask %i', (mask) => {
    expect(decode(REAL_TOKEN, { mask })).toBe(REAL_TOKEN);
  });

  it('refuses rather than truncates when the data will not fit', () => {
    const { encode } = loadEncoder();
    // A symbol that scans cleanly to *most* of a credential is worse than an error: the desk
    // would check somebody in against a token nobody minted.
    expect(() => encode('x'.repeat(1000))).toThrow(/exceeds version/);
  });

  it('picks the smallest version that fits, so the modules stay as large as they can', () => {
    const { encode } = loadEncoder();
    expect(encode('HELLO').length).toBe(21);             // version 1
    expect(encode(REAL_TOKEN).length).toBe(49);          // version 8
    expect(encode('x'.repeat(200)).length).toBe(57);     // version 10
  });
});

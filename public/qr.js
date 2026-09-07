/**
 * A QR encoder, because the attendance panel had none.
 *
 * The check-in flow is the headline of this system: a token that rotates every thirty seconds,
 * is single-use, and is bound to a person and a shift. The panel that presents it says "show
 * this at the desk" and the copy beside it talks about a scanner — and what it actually drew was
 * the base64 token as green text. No scanner can read that. The feature worked end to end at the
 * API and stopped one step short of the desk.
 *
 * The obvious shortcut is a QR image service. `app.js` already refused it, in a comment: the
 * token is a live credential and posting it to a third party is handing over the credential. So
 * the encoder has to be local, and there is no bundler here — every file in `public/` is a plain
 * script — which means writing it rather than importing it.
 *
 * **Scope, deliberately narrow.** Byte mode, error-correction level M, versions 1–12. That is
 * what this application needs (a ~150-character token lands in version 8) and every byte of table
 * beyond it would be unused weight in the offline shell. `encode()` throws rather than silently
 * truncating if something longer ever arrives, because a QR that scans to a truncated token is
 * worse than an error.
 *
 * Level M (~15% recovery) rather than L: this is read off a laptop screen at a desk, at an angle,
 * under whatever lighting the building has, and the extra redundancy costs a slightly denser
 * symbol rather than a slower flow.
 *
 * Verified by decoding: `tests/qr.test.ts` renders symbols from this encoder and reads them back
 * with an independent decoder, including the exact token shape the attendance endpoint mints.
 * The implementation follows ISO/IEC 18004; the tables below are from that standard.
 */
(function (global) {
  'use strict';

  /** [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords] */
  const EC_M = {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44], 11: [30, 1, 50, 4, 51], 12: [22, 6, 36, 2, 37],
  };

  /** Centres of the alignment patterns, per version. Version 1 has none. */
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  };

  const MAX_VERSION = 12;

  // --- GF(256), the field Reed–Solomon works in -------------------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // the QR generator polynomial
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** The generator polynomial for `n` error-correction codewords. */
  function generator(n) {
    let poly = [1];
    for (let i = 0; i < n; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        // (x + a^i) * poly, with coefficients stored highest-degree first: the x term shifts
        // left and the a^i term stays. Having these two the wrong way round builds
        // prod(a^i * x + 1) instead of prod(x + a^i) — a polynomial of the right *degree*, so
        // every symbol still came out the right size and the right shape, and every decoder
        // rejected it on the checksum. Data codewords matched a reference encoder byte for
        // byte; only the ten error-correction bytes were wrong.
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** Remainder of `data` divided by the generator — the EC codewords. */
  function ecCodewords(data, count) {
    const gen = generator(count);
    const rem = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let i = 0; i < count; i += 1) rem[i] ^= mul(gen[i + 1], factor);
    }
    return rem;
  }

  // --- Bit assembly -----------------------------------------------------------------------
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  };

  /** UTF-8 bytes. The token is ASCII, but nothing here should assume that. */
  function toBytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  /** The smallest version whose data capacity holds `byteLength`, or 0 if none does. */
  function versionFor(byteLength) {
    for (let v = 1; v <= MAX_VERSION; v += 1) {
      const [, g1, d1, g2, d2] = EC_M[v];
      const capacity = g1 * d1 + g2 * d2;
      // 4 bits of mode, 8 or 16 of character count, then the data itself.
      const header = 4 + (v < 10 ? 8 : 16);
      if (capacity * 8 >= header + byteLength * 8) return v;
    }
    return 0;
  }

  /** Data codewords for `text`, padded and interleaved with their EC blocks. */
  function codewords(text, version) {
    const bytes = toBytes(text);
    const [ecPerBlock, g1, d1, g2, d2] = EC_M[version];
    const total = g1 * d1 + g2 * d2;

    const buf = new BitBuffer();
    buf.put(4, 4); // byte mode
    buf.put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) buf.put(b, 8);
    // Terminator, then pad to a byte boundary, then the two alternating pad codewords.
    const capacityBits = total * 8;
    for (let i = 0; i < 4 && buf.bits.length < capacityBits; i += 1) buf.bits.push(0);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);
    const data = [];
    for (let i = 0; i < buf.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | buf.bits[i + j];
      data.push(byte);
    }
    const PADS = [0xec, 0x11];
    for (let i = 0; data.length < total; i += 1) data.push(PADS[i % 2]);

    // Split into blocks, compute EC per block, then interleave both — data codeword 0 of every
    // block, then codeword 1 of every block, and so on. This is what makes a burst of damage
    // land across many blocks rather than destroying one.
    const blocks = [];
    let at = 0;
    for (let i = 0; i < g1 + g2; i += 1) {
      const size = i < g1 ? d1 : d2;
      const chunk = data.slice(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: ecCodewords(chunk, ecPerBlock) });
    }

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i += 1) {
      for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
    }
    for (let i = 0; i < ecPerBlock; i += 1) {
      for (const block of blocks) out.push(block.ec[i]);
    }
    return out;
  }

  // --- Matrix -----------------------------------------------------------------------------
  /** `null` means "still free"; function patterns are written as 0/1 and then never moved. */
  function blankMatrix(size) {
    return Array.from({ length: size }, () => new Array(size).fill(null));
  }

  function placeFinder(m, row, col) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = onRing || inCore ? 1 : 0;
      }
    }
  }

  function placeFunctionPatterns(m, version) {
    const size = m.length;
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);

    // Timing patterns: the alternating row and column that let a decoder find the module grid.
    for (let i = 8; i < size - 8; i += 1) {
      m[6][i] = i % 2 === 0 ? 1 : 0;
      m[i][6] = i % 2 === 0 ? 1 : 0;
    }

    for (const r of ALIGN[version]) {
      for (const c of ALIGN[version]) {
        // Alignment patterns never overlap a finder.
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
          }
        }
      }
    }

    m[size - 8][8] = 1; // the dark module, always set

    // Reserve the format areas so the data walk skips them; the real bits are written later.
    for (let i = 0; i < 9; i += 1) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (let i = 0; i < 8; i += 1) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }

    // Version information, for version 7 and above.
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const bit = (bits >>> i) & 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
  }

  /** True where a module belongs to a function pattern and must not carry data. */
  function reservedMask(version, size) {
    const probe = blankMatrix(size);
    placeFunctionPatterns(probe, version);
    return probe.map((row) => row.map((cell) => cell !== null));
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  /** Walk the data bits up and down the two-module-wide columns, right to left. */
  function placeData(m, reserved, bits) {
    const size = m.length;
    let bit = 0;
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right -= 1; // the vertical timing column is not part of the walk
      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;
        for (let k = 0; k < 2; k += 1) {
          const col = right - k;
          if (reserved[row][col]) continue;
          m[row][col] = bit < bits.length ? bits[bit] : 0;
          bit += 1;
        }
      }
      upward = !upward;
    }
  }

  /** The four penalty rules, which together choose the mask that scans most reliably. */
  function penalty(m) {
    const size = m.length;
    let score = 0;

    const runScore = (line) => {
      let total = 0;
      let run = 1;
      for (let i = 1; i < line.length; i += 1) {
        if (line[i] === line[i - 1]) run += 1;
        else { if (run >= 5) total += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) total += 3 + (run - 5);
      return total;
    };
    for (let i = 0; i < size; i += 1) {
      score += runScore(m[i]);
      score += runScore(m.map((row) => row[i]));
    }

    for (let r = 0; r < size - 1; r += 1) {
      for (let c = 0; c < size - 1; c += 1) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // The finder-like 1:1:3:1:1 sequence appearing in the data, which confuses a decoder.
    const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const REVERSED = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const hasAt = (line, at, pat) => pat.every((p, i) => line[at + i] === p);
    for (let i = 0; i < size; i += 1) {
      const row = m[i];
      const col = m.map((r) => r[i]);
      for (let j = 0; j + 11 <= size; j += 1) {
        if (hasAt(row, j, PATTERN) || hasAt(row, j, REVERSED)) score += 40;
        if (hasAt(col, j, PATTERN) || hasAt(col, j, REVERSED)) score += 40;
      }
    }

    let dark = 0;
    for (const row of m) for (const cell of row) if (cell) dark += 1;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  function writeFormat(m, maskIndex) {
    const size = m.length;
    // Level M is 0b00. BCH(15,5), then XOR with the standard mask so an all-zero format is not
    // a valid pattern.
    const data = (0b00 << 3) | maskIndex;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // Two copies, and the two run in opposite directions — which is the part that is easy to get
    // backwards and produces a symbol no decoder will look at twice. Bit 0 of the vertical copy
    // sits at the top of the left column; bit 0 of the horizontal copy sits at the *right* end of
    // the top row. Getting this pair the wrong way round was worth eight modules and a symbol
    // that decoded to nothing at all.
    for (let i = 0; i < 15; i += 1) {
      const bit = (bits >>> i) & 1;
      // Vertical copy, down the left of the top-left finder, stepping over the timing row.
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;
      // Horizontal copy, right to left along the top.
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1; // the dark module, which the loop above may have written over
  }

  /**
   * Encode `text` and return the module matrix as an array of rows of 0/1.
   *
   * Throws when the text is longer than version 12 at level M can carry, rather than truncating:
   * a symbol that scans cleanly to *most* of a credential is the worst possible outcome here.
   */
  function encode(text, opts) {
    // `opts.mask` pins the mask instead of scoring for it. Only the tests use it: comparing one
    // mask at a time against a reference encoder is what separates "my construction is wrong"
    // from "my penalty scoring picked a different, equally valid mask".
    const forced = opts && Number.isInteger(opts.mask) ? opts.mask : null;
    const bytes = toBytes(text);
    const version = versionFor(bytes.length);
    if (!version) {
      throw new Error(`qr: ${bytes.length} bytes exceeds version ${MAX_VERSION} at level M`);
    }
    const size = version * 4 + 17;
    const words = codewords(text, version);
    const bits = [];
    for (const word of words) for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1);

    const reserved = reservedMask(version, size);
    let best = null;
    for (let maskIndex = 0; maskIndex < 8; maskIndex += 1) {
      if (forced !== null && maskIndex !== forced) continue;
      const m = blankMatrix(size);
      placeFunctionPatterns(m, version);
      placeData(m, reserved, bits);
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (!reserved[r][c] && MASKS[maskIndex](r, c)) m[r][c] ^= 1;
        }
      }
      writeFormat(m, maskIndex);
      const score = penalty(m);
      if (!best || score < best.score) best = { score, m };
    }
    return best.m;
  }

  /**
   * Draw `text` into `canvas` as a QR symbol.
   *
   * Light modules are drawn in cream rather than pure white and the quiet zone is included: the
   * four-module border is not decoration, it is part of the specification, and a symbol butted
   * against a dark panel is one a phone will refuse to see.
   */
  function draw(canvas, text, opts) {
    const options = opts || {};
    const matrix = encode(text);
    const quiet = options.quiet == null ? 4 : options.quiet;
    const modules = matrix.length + quiet * 2;
    const scale = Math.max(1, Math.floor((options.size || 256) / modules));
    const px = modules * scale;

    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = options.light || '#FFF3E0';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = options.dark || '#08152B';
    for (let r = 0; r < matrix.length; r += 1) {
      for (let c = 0; c < matrix.length; c += 1) {
        if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return { modules: matrix.length, pixels: px };
  }

  /**
   * Render `text` as a QR into `el`, replacing whatever is there.
   *
   * The token string stays in the DOM as visually-hidden text beside the canvas. A canvas is
   * opaque to a screen reader and to anyone who cannot hold a phone steady, and the desk can
   * always fall back to reading the code out — so the scannable form is added without taking
   * the readable one away.
   *
   * Passing an empty string clears the box, which is what the handover teardown needs.
   */
  function render(el, text) {
    if (!el) return null;
    el.textContent = '';
    if (!text) return null;
    let result = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'qr-canvas';
      result = draw(canvas, text, { size: 320 });
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Attendance QR code. Show this to the desk scanner.');
      el.append(canvas);
    } catch (err) {
      // Better a legible token than a blank box: the desk can type it.
      el.textContent = text;
      el.classList.add('qr-fallback');
      return null;
    }
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = text;
    el.append(sr);
    return result;
  }

  global.NexusQR = { encode, draw, render };
})(typeof window !== 'undefined' ? window : globalThis);

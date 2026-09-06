#!/usr/bin/env node
/**
 * CSP audit for the dashboard shell (plan C1/C10, M1).
 *
 * The server sends `script-src 'self'; script-src-attr 'none'` and the shell
 * is meant to work with `font-src 'self'` and no third-party requests. Static
 * analysis over public/ catches the regressions a browser would only report
 * as a silently dead control:
 *
 *   public/**\/*.html
 *     - `<script>` without `src`           (inline script is blocked)
 *     - `on<event>=` attributes            (inline handlers are blocked)
 *     - `href`/`src` to http(s)://…        (third-party resource or link),
 *       except https://adonix.hackillinois.org (the identity provider) and
 *       `<a href>` navigation links, which CSP does not govern — the OSM
 *       attribution link is required by the ODbL. `data:` URLs are fine.
 *   public/**\/*.js
 *     - the string `fonts.googleapis`      (fonts are self-hosted)
 *
 * Exit 1 with one `file:line: message` per violation; no dependencies.
 *
 *   npm run csp:audit
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const ALLOWED_ORIGINS = ['https://adonix.hackillinois.org'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
const report = (file, line, msg) => violations.push(`${relative(ROOT, file)}:${line}: ${msg}`);

/** 1-based line number of a character offset. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function auditHtml(file, text) {
  // Every tag, with its offset, so line numbers are exact.
  const tagRe = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const [, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    const line = lineAt(text, m.index);

    if (name === 'script' && !/\bsrc\s*=/.test(attrs)) {
      report(file, line, '<script> without src (inline script is blocked by script-src \'self\')');
    }

    // Inline event handlers on any element.
    const handlerRe = /\s(on[a-z]+)\s*=/gi;
    let h;
    while ((h = handlerRe.exec(attrs))) {
      report(file, line, `inline event handler ${h[1]}= (blocked by script-src-attr 'none')`);
    }

    // External resource references.
    const urlRe = /\s(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let u;
    while ((u = urlRe.exec(attrs))) {
      const attr = u[1].toLowerCase();
      const value = (u[3] ?? u[4] ?? u[5] ?? '').trim();
      if (!/^https?:\/\//i.test(value)) continue; // relative, data:, blob:, fragment
      if (ALLOWED_ORIGINS.some((o) => value === o || value.startsWith(o + '/'))) continue;
      if (name === 'a' && attr === 'href') continue; // navigation, not a resource load
      report(file, line, `<${name} ${attr}="${value}"> loads a third-party resource`);
    }
  }
}

function auditJs(file, text) {
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (l.includes('fonts.googleapis')) report(file, i + 1, 'references fonts.googleapis (fonts must be self-hosted from public/fonts)');
  });
}

for (const file of walk(PUBLIC)) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.html')) auditHtml(file, text);
  else auditJs(file, text);
}

if (violations.length) {
  console.error(`CSP audit: ${violations.length} violation(s)`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('CSP audit: clean');

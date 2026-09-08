/**
 * Proof that a documentation pass changed no executable code.
 *
 * A large comment-only sweep is unreviewable by eye: the diff is thousands of lines of prose,
 * and a single altered token hiding inside it reads as more prose. Rather than trusting a
 * reviewer's attention, this tokenises both versions of every changed TypeScript file with the
 * compiler's own scanner and compares the token streams with comments and whitespace discarded.
 * Identical streams mean the change is provably comments only. A difference is reported with the
 * first token that diverged, which is the line a human should actually go and look at.
 *
 * This is deliberately stricter than "the tests still pass". A comment pass that renames a local
 * variable or reorders two independent statements is still green under the suite; it is out of
 * contract here, because the contract was that no executable token moves. Loosening this to
 * "behaviour is unchanged" would put the judgement back into a human's head, which is the thing
 * that does not scale to a four-thousand-line diff.
 *
 *   usage: node scripts/checkCommentsOnly.mjs [git-ref]     (default: HEAD)
 *
 * Exit 0 when every modified file is comments-only, 1 otherwise. Added and deleted files are
 * listed as "not comparable" rather than passed over in silence: a new file is by definition not
 * a comment-only change, and the caller needs to know it was in the set.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import ts from 'typescript';

const ref = process.argv[2] ?? 'HEAD';

/** Changed TypeScript files, split into those that can be compared and those that cannot. */
function changedFiles() {
  const out = execFileSync('git', ['diff', '--name-status', ref, '--', '*.ts'], { encoding: 'utf8' });
  const modified = [];
  const notComparable = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0];
    const file = parts[parts.length - 1];
    if (status.startsWith('M')) modified.push(file);
    else notComparable.push(status + ' ' + file);
  }
  return { modified, notComparable };
}

/**
 * The file's tokens, with comments and whitespace discarded.
 *
 * This parses and then walks to the leaves rather than running the raw scanner over the text,
 * and the difference is not stylistic. A bare `createScanner` has no parser context, so at a
 * backtick it cannot know whether it is opening a template literal or closing one: it scans from
 * one backtick to the next and swallows everything in between. In this codebase — where a
 * template literal inside a function body is ordinary — that desynchronises the stream and
 * reports an entire function as "one changed token". The first version of this script did
 * exactly that and accused eight files of changing code that had not changed.
 *
 * `createSourceFile` gives the parser the context the scanner lacks, and `getChildren()` on a
 * tree built with `setParentNodes` yields the real leaf tokens. Comments are trivia and are
 * never leaves, so they drop out for free.
 *
 * Token *text* is compared and not only the kind, because kind alone treats `75` and `750` as
 * the same token, and this repository writes geofence radii and grace windows as bare numeric
 * literals.
 */
function tokens(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const out = [];
  const walk = (node) => {
    // A `/** … */` block is parsed into JSDoc nodes and hung off the declaration it precedes, so
    // it reaches this walk as a subtree rather than being dropped as trivia the way a `//` or a
    // `/* … */` comment is. Skipping the whole JSDoc range here is the entire point of the
    // script: a docblock added above a method must not count as a change to the method.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // A leaf. The EOF token carries no text and only adds noise to a mismatch report.
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(node.kind + ' ' + node.getText(sourceFile));
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sourceFile);
  return out;
}

const { modified, notComparable } = changedFiles();
const problems = [];

for (const file of modified) {
  let before;
  try {
    before = execFileSync('git', ['show', ref + ':' + file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    problems.push(file + ': not present at ' + ref + ', cannot compare');
    continue;
  }
  const a = tokens(file, before);
  const b = tokens(file, fs.readFileSync(file, "utf8"));
  if (a.length === b.length && a.every((t, i) => t === b[i])) continue;

  // Report the first divergence in the reader's terms rather than as scanner kinds.
  const shared = Math.min(a.length, b.length);
  let i = 0;
  while (i < shared && a[i] === b[i]) i += 1;
  const text = (t) => (t === undefined ? '<end of file>' : JSON.stringify(t.slice(t.indexOf(' ') + 1)));
  problems.push(
    file + ': executable code changed (' + a.length + ' tokens -> ' + b.length + '). ' +
    'First difference at token ' + i + ': ' + text(a[i]) + ' became ' + text(b[i]) + '.'
  );
}

if (notComparable.length) {
  console.log('checkCommentsOnly: ' + notComparable.length + ' file(s) added or removed, not comparable:');
  for (const entry of notComparable) console.log('  ' + entry);
}

if (problems.length) {
  console.error('\ncheckCommentsOnly: ' + problems.length + ' of ' + modified.length + ' modified file(s) are NOT comments-only:\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log('checkCommentsOnly: OK - all ' + modified.length + ' modified TypeScript file(s) differ only in comments and whitespace.');

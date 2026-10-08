import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every page under app/admin must call the gate before anything that can read
// the database. Next renders the page segment even when the layout does not
// return `children`, so the layout's check does not protect a page: the page
// data is in the response of every GET (plain HTML, `RSC: 1`, partial render).
//
// This is a TEXT check of the page source. It catches the common mistakes; it
// is not a proof. It is strict on purpose: between the start of the page
// function and the refusal line, a page may only read its parameters, get the
// database handle, read the headers, and call the gate.

const ADMIN = resolve(dirname(fileURLToPath(import.meta.url)), '../app/admin');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

const ENTRY = 'export default async function';
const GATE = 'await requirePublisher(';
const DENY = 'if (!gate.ok) return null;';
/** The only names a page may call before the refusal line. None of them sends a query. */
const ALLOWED_CALLS = ['getDb', 'headers', 'requirePublisher'];

/** Index just after the `{` that opens the body of the function declared at `start`. */
function bodyStart(src: string, start: number): number {
  let depth = 0;
  for (let i = src.indexOf('(', start); i > -1 && i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.indexOf('{', i) + 1;
  }
  return src.length;
}

/** Every way the source of one admin page breaks the rule. Empty means the page passes. */
function violations(src: string): string[] {
  const out: string[] = [];
  const start = src.indexOf(ENTRY);
  const gate = src.indexOf(GATE);
  const deny = src.indexOf(DENY);

  // These run outside the page function, so the gate in the page cannot cover them.
  if (/generateMetadata|generateViewport/.test(src)) out.push('has generateMetadata or generateViewport');

  if (start === -1) out.push(`has no \`${ENTRY}\` (the page function must be declared and exported in one statement)`);
  if (gate === -1) out.push(`has no \`${GATE}\``);
  if (deny === -1) out.push(`has no \`${DENY}\``);
  if (start > -1 && gate > -1 && gate < start) out.push('calls the gate before the page function starts');
  if (gate > -1 && deny > -1 && deny < gate) out.push('has the refusal line before the gate');
  if (start === -1 || deny < start) return out;

  if (/getDb\(|\bsql`|\bdb`/.test(src.slice(0, start))) out.push('touches the database at module level');

  // From the first statement of the page function to the refusal line.
  const body = src.slice(bodyStart(src, start), deny);
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!ALLOWED_CALLS.includes(m[1]!)) out.push(`calls \`${m[1]}(\` before the refusal line`);
  }
  if (body.includes('`')) out.push('has a template literal before the refusal line');
  if (/\breturn\b/.test(body)) out.push('has a `return` before the refusal line');
  if (/\bif\s*\(/.test(body)) out.push('has an `if (` before the refusal line');
  // The three permitted awaits: params or searchParams, headers(), the gate.
  if ((body.match(/\bawait\b/g)?.length ?? 0) > 3) out.push('has more than 3 awaits before the refusal line');
  return out;
}

const SPECIAL = /(^|\/)(page|layout|template|default|loading|error|not-found)\.(tsx?|jsx?|mdx?)$/;
const special = walk(ADMIN).map(f => relative(ADMIN, f)).filter(f => SPECIAL.test(f)).sort();
const pages = special.filter(f => /(^|\/)page\.tsx$/.test(f));

describe('every admin page gates before it reads', () => {
  it('the set of admin page and layout files is the known set', () => {
    // If this fails, you added or removed a special file under app/admin.
    //  - A new page.tsx MUST call requirePublisher first (see `violations`
    //    above); then add it to this list.
    //  - A nested layout, template or default file MUST NOT read data: Next
    //    renders it for a request with no session. Read data in the page,
    //    after the gate.
    //  - error.tsx is a client component and cannot read the database; the
    //    next test keeps it that way.
    expect(special, 'a new admin page must call the gate first and be added here; ' +
      'a nested layout, template or default file must not read data').toEqual([
      'error.tsx',
      'layout.tsx',
      'page.tsx',
      'review/[id]/page.tsx',
    ]);
  });

  it('error.tsx stays a client component', () => {
    expect(readFileSync(join(ADMIN, 'error.tsx'), 'utf8').trimStart()).toMatch(/^'use client';/);
  });

  it.each(pages)('%s gates before it does anything else', (file) => {
    expect(violations(readFileSync(join(ADMIN, file), 'utf8'))).toEqual([]);
  });

  it('no route handler under app/admin other than login, callback, logout', () => {
    const routes = walk(ADMIN).map(f => relative(ADMIN, f)).filter(f => /(^|\/)route\.[jt]sx?$/.test(f));
    expect(routes.sort()).toEqual(['callback/route.ts', 'login/route.ts', 'logout/route.ts']);
  });
});

// The checker is text matching, so it can stop matching without a failure.
// These cases prove that it still flags each mistake.
describe('the admin page checker flags each known mistake', () => {
  const SIGNATURE = 'export default async function Page({ params }: { params: Promise<{ id: string }> }) {';
  const PARAMS = '  const { id } = await params;';
  const HANDLE = '  const db = getDb();';
  const GATED = ['  const gate = await requirePublisher(db, await headers());', '  if (!gate.ok) return null;'];
  const REST = ['  return <List rows={await listDrafts(db, id)} />;', '}'];
  const IMPORTS = "import { getDb } from '../../src/web/db.js';";
  const lines = (...l: (string | string[])[]) => l.flat().join('\n');

  it('accepts a correct minimal page', () => {
    expect(violations(lines(IMPORTS, SIGNATURE, PARAMS, HANDLE, GATED, REST))).toEqual([]);
  });

  const bad: [string, string, RegExp][] = [
    ['a query inside generateMetadata',
      lines(IMPORTS, 'export async function generateMetadata() {', '  return { title: (await getLatest(getDb(), 1)).title };', '}',
        SIGNATURE, PARAMS, HANDLE, GATED, REST),
      /generateMetadata/],
    ['a page function that is exported in a separate statement',
      lines(IMPORTS, 'async function Page() {', HANDLE, GATED, REST, 'export default Page;'),
      /has no `export default async function`/],
    ['a tagged-template query before the gate',
      lines(IMPORTS, SIGNATURE, '  const sql = getDb();', '  const rows = await sql`select * from announcements`;',
        '  const gate = await requirePublisher(sql, await headers());', '  if (!gate.ok) return null;', REST),
      /template literal/],
    ['an early return before the gate',
      lines(IMPORTS, SIGNATURE, HANDLE, '  return <Child db={db} />;', GATED, REST),
      /`return` before/],
    ['a module-level getDb()',
      lines(IMPORTS, 'const db = getDb();', SIGNATURE, PARAMS, GATED, REST),
      /module level/],
    ['the gate inside an if branch',
      lines(IMPORTS, SIGNATURE, PARAMS, HANDLE, '  if (id) {', GATED, '  }', REST),
      /`if \(` before/],
    ['a helper call that hides the database handle',
      lines(IMPORTS, SIGNATURE, '  const data = fetchAll(getDb());', HANDLE, GATED, REST),
      /calls `fetchAll\(`/],
    ['a query in parallel with the gate',
      lines(IMPORTS, SIGNATURE, HANDLE,
        '  const [gate, drafts] = await Promise.all([requirePublisher(db, await headers()), listDrafts(db)]);',
        '  if (!gate.ok) return null;', REST),
      /calls `listDrafts\(`/],
    ['a page with no gate',
      lines(IMPORTS, SIGNATURE, HANDLE, REST),
      /has no `await requirePublisher\(`/],
  ];

  it.each(bad)('flags %s', (_name, src, expected) => {
    expect(violations(src).join('\n')).toMatch(expected);
  });
});

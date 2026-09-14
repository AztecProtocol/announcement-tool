import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Client components ('use client') are bundled for the browser. Any Node
 * built-in reached from them is replaced by a polyfill, and the crypto polyfill
 * pulls in vm-browserify, which evaluates strings. Under the nonce-based CSP
 * (no 'unsafe-eval') that is a violation, and under enforcement it breaks the
 * page. This walks every value import from a client component into src/ and
 * asserts none of the modules reached imports a Node built-in.
 */

const ROOT = resolve(__dirname, '..');
const NODE_BUILTIN = /^\s*import\s[^;]*?\sfrom\s+['"](node:[a-z_]+|crypto|fs|path|vm|buffer|os|child_process|net|tls|http|https|dns|stream|util)['"]/m;
// `import ... from` and `export ... from` both pull the target into the bundle.
// Dynamic import() is not handled; none exist in app/ or src/ today.
const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function localImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(VALUE_IMPORT)) {
    const base = resolve(dirname(file), m[1]!.replace(/\.js$/, ''));
    // Imports are written with a .js suffix; the source is .ts or .tsx.
    const target = [`${base}.ts`, `${base}.tsx`].find((p) => existsSync(p));
    if (!target) throw new Error(`cannot resolve ${m[1]} from ${file}`);
    out.push(target);
  }
  return out;
}

describe('client bundle boundary', () => {
  const clientFiles = walk(join(ROOT, 'app')).filter((f) => /^['"]use client['"]/.test(readFileSync(f, 'utf8')));

  it('finds the client components', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('no module reachable from a client component imports a Node built-in', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [...clientFiles];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let src: string;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      // A 'use server' module is not bundled for the browser: the client gets a
      // reference to each action, not the code. Stop the walk there.
      if (/^['"]use server['"]/.test(src)) continue;
      if (NODE_BUILTIN.test(src)) offenders.push(file.replace(ROOT + '/', ''));
      for (const dep of localImports(file)) {
        if (dep.startsWith(join(ROOT, 'src')) || dep.startsWith(join(ROOT, 'app'))) queue.push(dep);
      }
    }
    expect(offenders).toEqual([]);
  });
});

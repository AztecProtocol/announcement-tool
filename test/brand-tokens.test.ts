import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Guards the 2026-11 brand palette in the stylesheet: Paper / Ink / Lime,
// no derived near-white, no Lime page strip, and none of the retired
// Parchment / Chartreuse tokens or hexes left anywhere in app/ or src/.

const ROOT = join(__dirname, '..');
const CSS = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8');

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

type Spec = [number, number, number];
// Specificity of one simple CSS selector (enough for this stylesheet: classes,
// attributes, pseudo-classes incl. :not(...) arguments, type selectors).
function specificity(sel: string): Spec {
  let a = 0, b = 0, c = 0;
  let s = sel;
  // :not(x) counts as x
  s = s.replace(/:not\(([^()]*)\)/g, (_m, inner: string) => {
    const [ia, ib, ic] = specificity(inner); a += ia; b += ib; c += ic; return ' ';
  });
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
  s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
  s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
  s = s.replace(/::[\w-]+/g, () => { c++; return ' '; });
  s = s.replace(/:[\w-]+/g, () => { b++; return ' '; });
  c += (s.match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return [a, b, c];
}
function cmp(x: Spec, y: Spec): number {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function rules(): { selectors: string[]; body: string; at: number }[] {
  const out: { selectors: string[]; body: string; at: number }[] = [];
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: m[1].split(',').map(x => x.trim()), body: m[2], at: m.index ?? 0 });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('brand tokens (2026-11 brand pack)', () => {
  it('defines the brand colours from the pack', () => {
    const root = rule(':root');
    expect(root).toMatch(/--paper:\s*#fff9f2;/);
    expect(root).toMatch(/--ink:\s*#141900;/);
    expect(root).toMatch(/--lime:\s*#c8fa00;/);
    expect(root).toMatch(/--grey-50:\s*#e8e8e6;/);
    expect(root).toMatch(/--grey-100:\s*#b6b8b0;/);
    expect(root).toMatch(/--grey-300:\s*#626554;/);
  });

  it('uses no derived near-white surface colour', () => {
    expect(CSS).not.toMatch(/--paper-raised/);
    expect(CSS.toLowerCase()).not.toContain('#fffdf9');
  });

  it('puts no Lime strip on the page body', () => {
    const body = rule('body');
    expect(body).not.toMatch(/border/);
    expect(body).toMatch(/background:\s*var\(--paper\)/);
  });

  it('links and the focus ring are Ink, not blue', () => {
    const root = rule(':root');
    expect(root).toMatch(/--link:\s*var\(--ink\)/);
    expect(root).toMatch(/--focus:\s*var\(--ink\)/);
  });

  it('plain-list row rules hit only direct children (not nested tag <li>)', () => {
    expect(CSS).toMatch(/ul\.plain > li\s*\{/);
    expect(CSS).not.toMatch(/ul\.plain li[\s:{]/);
  });

  // The base `button:hover:not(:disabled)` paints the Ink-family hover fill
  // (specificity 0,2,1). Outline buttons with a transparent ground must
  // override it with a Grey 50 fill + Ink text, or their Grey 300 / Ink text
  // lands on #2c3214 (2.23:1 / 1.35:1).
  it('transparent buttons override the filled-button hover with Grey 50 + Ink', () => {
    const BASE = specificity('button:hover:not(:disabled)');
    const baseAt = CSS.indexOf('button:hover:not(:disabled) {');
    for (const kind of ['.role-tag', '.preview-mode button', '.draft-discard-cancel']) {
      const hits = rules().filter(r =>
        r.selectors.some(sel => sel.startsWith(kind) && sel.includes(':hover')
          && (cmp(specificity(sel), BASE) > 0 || (cmp(specificity(sel), BASE) === 0 && r.at > baseAt)))
        && /background:\s*var\(--line-soft\)/.test(r.body)
        && /(^|[;\s])color:\s*var\(--ink\)/.test(r.body));
      expect(hits.map(h => h.selectors.join(', ')), kind).not.toEqual([]);
    }
  });

  it('channel-preview links use a client-like blue, not the Ink --link token', () => {
    for (const sel of ['.pv-link', '.pv-emailhtml a']) {
      expect(rule(sel)).toMatch(/color:\s*#0b57d0/);
    }
  });

  it('leaves no retired token name or hex in app/ or src/', () => {
    const retired = [
      /--parchment/i, /--chartreuse/i, /--ink-3\b/, /--paper-raised/,
      /#f2eee1/i, /#1a1400/i, /#d4ff28/i, /#faf8f1/i, /#ddd6c2/i, /#e8e2d2/i,
      /#5f5642/i, /#8a8069/i, /#1f4d6b/i, /#2a2100/i,
    ];
    const offenders: string[] = [];
    for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'src'))]) {
      const text = readFileSync(f, 'utf8');
      for (const re of retired) if (re.test(text)) offenders.push(`${relative(ROOT, f)}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});

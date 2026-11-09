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

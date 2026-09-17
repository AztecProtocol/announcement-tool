import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP = resolve(__dirname, '../app');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** A raw submit button outside <noscript>. JSX attributes may span lines. */
const RAW_SUBMIT = /<button\b[^>]*\btype="submit"[^>]*>/g;

describe('submitting buttons show a pending state', () => {
  const files = walk(APP);

  it('no server-rendered form uses a raw submit button (use SubmitButton, which knows when the form is pending)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/^['"]use client['"]/.test(src)) continue;
      const withoutNoscript = src.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
      if (RAW_SUBMIT.test(withoutNoscript)) offenders.push(f.replace(APP + '/', 'app/'));
      RAW_SUBMIT.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });

  it('SubmitButton renders a plain enabled submit button at rest', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { default: SubmitButton } = await import('../app/submit-button.js');
    // createElement's typings fold `props` and the variadic `children` into two
    // separate parameters, but SubmitButton's props type requires `children` on
    // the props object itself; the cast only relaxes that call-site mismatch,
    // it does not change what SubmitButton accepts or how it renders.
    const html = renderToStaticMarkup(
      createElement(SubmitButton, { pendingLabel: 'Working…' } as React.ComponentProps<typeof SubmitButton>, 'Subscribe by email'),
    );
    expect(html).toBe('<button type="submit" aria-busy="false">Subscribe by email</button>');
  });

  it('the spinner animation lives in the stylesheet and honours reduced motion', () => {
    const css = readFileSync(join(APP, 'globals.css'), 'utf8');
    expect(css).toMatch(/\.spinner\s*\{/);
    expect(css).toMatch(/@keyframes\s+spin/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.spinner/);
  });

  it('every client component that calls a server action renders the spinner', () => {
    const mustHave = [
      'webhook-form.tsx', 'admin/compose-form.tsx', 'admin/review/[id]/publish-control.tsx',
      'admin/discard-button.tsx', 'admin/withdraw-button.tsx', 'admin/cancel-schedule-button.tsx',
    ];
    const missing = mustHave.filter((f) => !readFileSync(join(APP, f), 'utf8').includes('className="spinner"'));
    expect(missing).toEqual([]);
  });

  it('the publish control tracks which action is pending, not only that one is', () => {
    const src = readFileSync(join(APP, 'admin/review/[id]/publish-control.tsx'), 'utf8');
    expect(src).toContain('pendingKey');
    const callSites = (src.match(/\brun\(/g) ?? []).length - (src.match(/function run\(/g) ?? []).length;
    const keyed = (src.match(/\brun\('[a-z-]+',/g) ?? []).length;
    expect(callSites).toBeGreaterThan(0);
    expect(keyed).toBe(callSites); // an unkeyed run(() => …) call fails here
  });
});

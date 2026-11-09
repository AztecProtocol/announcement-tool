import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Root layout branding: metadataBase follows PUBLIC_BASE_URL (so Next writes
// absolute metadata URLs against the real host), the favicon and apple-touch
// icon come from the app/icon.svg + app/apple-icon.png file conventions rather
// than a metadata `icons` override, and the header shows the 2026 wordmark.

const ROOT = join(__dirname, '..');
const saved = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = saved;
});

type Meta = { metadataBase?: URL | null; icons?: unknown; title?: unknown };

async function loadMetadata(): Promise<Meta> {
  const mod = (await import('../app/layout.js')) as {
    metadata?: Meta;
    generateMetadata?: () => Meta | Promise<Meta>;
  };
  return mod.generateMetadata ? await mod.generateMetadata() : (mod.metadata ?? {});
}

describe('root layout branding', () => {
  it('sets metadataBase from PUBLIC_BASE_URL', async () => {
    process.env.PUBLIC_BASE_URL = 'https://brand-test.example/';
    const meta = await loadMetadata();
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(meta.metadataBase?.href).toBe('https://brand-test.example/');
  });

  it('declares no icons override (file conventions supply them)', async () => {
    const meta = await loadMetadata();
    expect(meta.icons).toBeUndefined();
    expect(existsSync(join(ROOT, 'app', 'icon.svg'))).toBe(true);
    expect(existsSync(join(ROOT, 'app', 'apple-icon.png'))).toBe(true);
  });

  it('renders the new ink wordmark at 104 × 24 in the header', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { default: RootLayout } = await import('../app/layout.js');
    const html = renderToStaticMarkup(createElement(RootLayout, null, createElement('p', null, 'x')));
    expect(html).toMatch(/<img src="\/brand\/aztec-wordmark-ink\.svg" alt="Aztec" width="104" height="24"\/>/);
  });

  it('ships the 2026 wordmark (Ink #141900, 619 × 142.58 viewBox)', () => {
    const svg = readFileSync(join(ROOT, 'public', 'brand', 'aztec-wordmark-ink.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 619.137 142.58"');
    expect(svg).toContain('fill="#141900"');
  });

  it('the favicon is the Paper symbol on an Ink tile', () => {
    const svg = readFileSync(join(ROOT, 'app', 'icon.svg'), 'utf8');
    expect(svg).toMatch(/<rect[^>]*fill="#141900"/);
    expect(svg).toContain('fill="#FFF9F2"');
  });

  it('retired brand files are gone', () => {
    for (const f of ['aztec-wordmark-parchment.svg', 'aztec-symbol.png']) {
      expect(existsSync(join(ROOT, 'public', 'brand', f))).toBe(false);
    }
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { testSql, resetDb, TEST_DB_URL } from './helpers.js';
import { createDraft, requestPublish, confirmPublish } from '../src/core/announcements.js';
import type { Announcement, AnnouncementInput, Severity } from '../src/core/types.js';
import {
  SEVERITY_EMBED_COLOR, announcementSummary, announcementMetadata, announcementViewport, SITE_NAME,
} from '../src/web/link-preview.js';
import { renderBodyHtml } from '../src/core/render.js';
import { existsSync } from 'node:fs';

const SITE_IMG = { url: '/brand/og-site.png', width: 1200, height: 630, type: 'image/png' };
const ANN_IMG = { url: '/brand/og-announcement.png', width: 600, height: 600, type: 'image/png' };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Visible text of the first paragraph as the page renders it.
function pageText(md: string): string {
  const first = renderBodyHtml(md).split('\n').find(l => l.startsWith('<p')) ?? '';
  return first.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// Link previews (Open Graph / Twitter card) and the severity-coloured embed
// bar (theme-color) that Discord and other chat clients draw from them.

const ROOT = join(__dirname, '..');
const savedBase = process.env.PUBLIC_BASE_URL;
afterEach(() => {
  if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBase;
});

const ann = (severity: Severity, over: Partial<Announcement> = {}): Announcement => ({
  id: 'ann_X', revision: 1, slug: `2026-11-upgrade-${severity}`, type: 'upgrade',
  networks: ['mainnet'], audiences: ['operators'], severity,
  title: `Upgrade (${severity})`,
  bodyMd: '## Why\n\nSequencers and provers must **upgrade** before the deadline.\n\nSecond paragraph.',
  actionsRequired: [], links: [], status: 'published', createdBy: 'a@x', publishedAt: '2026-11-09T10:00:00Z',
  ...over,
});

function pngSize(path: string): { w: number; h: number; colorType: number } {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

describe('severity embed colours', () => {
  it('are the dark-background embed colours, one per severity', () => {
    expect(SEVERITY_EMBED_COLOR).toEqual({ critical: '#e0362b', recommended: '#d9a21b', info: '#3b82c4' });
  });
});

describe('announcementSummary', () => {
  it('takes the first prose paragraph, skips headings, strips markdown', () => {
    expect(announcementSummary('## Why\n\nSequencers must **upgrade** `now`.\n\nMore.'))
      .toBe('Sequencers must upgrade now.');
  });
  it('turns links into their label and collapses whitespace', () => {
    expect(announcementSummary('See [the notes](https://x.test/n)\nfor   details.')).toBe('See the notes for details.');
  });
  it('cuts long text at a word boundary with an ellipsis, at most 200 chars', () => {
    const s = announcementSummary(('word ').repeat(100));
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/\s…$/);
  });
  it('is empty for an empty body', () => {
    expect(announcementSummary('')).toBe('');
  });

  it('counts code points: 150 emoji stay whole, 250 are cut without a lone surrogate', () => {
    const e150 = '🚀'.repeat(150);
    expect(announcementSummary(e150)).toBe(e150);
    const cut = announcementSummary('🚀'.repeat(250));
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(LONE_SURROGATE.test(cut)).toBe(false);
  });

  it('cuts long CJK text without spaces at 200 code points, astral characters intact', () => {
    const bmp = announcementSummary('漢'.repeat(300));
    expect(Array.from(bmp)).toHaveLength(200);
    expect(bmp).toBe(`${'漢'.repeat(199)}…`);
    const astral = announcementSummary('𠀀'.repeat(300));
    expect(Array.from(astral)).toHaveLength(200);
    expect(LONE_SURROGATE.test(astral)).toBe(false);
  });

  it('a javascript: link stays literal, as on the page (no stray "click)")', () => {
    const md = 'See [click](javascript:alert(1)) now.';
    expect(announcementSummary(md)).not.toContain('click)');
    expect(announcementSummary(md)).toBe(pageText(md));
  });

  it('a URL with balanced parentheses becomes just its label, as on the page', () => {
    const md = 'Read [the wiki](https://en.wikipedia.org/wiki/Foo_(bar)) first.';
    expect(announcementSummary(md)).toBe('Read the wiki first.');
    expect(pageText(md)).toBe('Read the wiki first.');
  });

  it('uses the page heading rule: ## and ### are skipped, a lone # line is page text', () => {
    expect(announcementSummary('### Why\n\nBody.')).toBe('Body.');
    expect(announcementSummary('# Not a heading here\n\nBody.')).toBe(pageText('# Not a heading here\n\nBody.'));
  });

  it('skips paragraphs that start with a code fence, an HTML comment or a quote', () => {
    expect(announcementSummary('```\ncode\n```\n\nBody one.')).toBe('Body one.');
    expect(announcementSummary('<!-- note -->\n\nBody two.')).toBe('Body two.');
    expect(announcementSummary('> quoted\n\nBody three.')).toBe('Body three.');
  });

  it('matches the page text for ordinary prose with bold, code and links', () => {
    const md = 'Run `aztec --version` and **upgrade**; see [notes](https://x.test/n).';
    expect(announcementSummary(md)).toBe(pageText(md));
  });
});

describe('announcementMetadata', () => {
  for (const sev of ['critical', 'recommended', 'info'] as const) {
    it(`${sev}: og + twitter summary card with the canonical URL`, () => {
      process.env.PUBLIC_BASE_URL = 'https://announce.example';
      const m = announcementMetadata(ann(sev));
      expect(m.title).toBe(`Upgrade (${sev})`);
      expect(m.description).toBe('Sequencers and provers must upgrade before the deadline.');
      expect(m.openGraph).toMatchObject({
        type: 'article',
        url: `https://announce.example/a/2026-11-upgrade-${sev}`,
        title: `Upgrade (${sev})`,
        description: 'Sequencers and provers must upgrade before the deadline.',
        siteName: SITE_NAME,
      });
      expect(m.twitter).toMatchObject({ card: 'summary', title: `Upgrade (${sev})` });
      expect(m.openGraph).toMatchObject({ images: [ANN_IMG] });
      expect(m.twitter).toMatchObject({ images: [ANN_IMG] });
      expect(announcementViewport(ann(sev))).toEqual({ themeColor: SEVERITY_EMBED_COLOR[sev] });
    });
  }

  it('falls back to the site description when the body has no prose', () => {
    const m = announcementMetadata(ann('info', { bodyMd: '## Only a heading' }));
    expect(m.description).toBe('Upgrades, governance events and operational notices for Aztec operators.');
  });
});

describe('site-level preview (home, archive)', () => {
  it('layout: large image card and site name, no theme-color', async () => {
    const mod = await import('../app/layout.js');
    const m = mod.generateMetadata();
    expect(m.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(m.openGraph).toMatchObject({ type: 'website', siteName: SITE_NAME, images: [SITE_IMG] });
    expect(m.twitter).toMatchObject({ images: [SITE_IMG] });
    expect((mod as Record<string, unknown>).generateViewport).toBeUndefined();
    expect((mod as Record<string, unknown>).viewport).toBeUndefined();
  });

  it('home and archive carry their own og:url', async () => {
    process.env.PUBLIC_BASE_URL = 'https://announce.example';
    const home = await import('../app/page.js');
    const archive = await import('../app/archive/page.js');
    expect(home.generateMetadata().openGraph).toMatchObject({ url: 'https://announce.example/', siteName: SITE_NAME });
    expect(archive.generateMetadata().openGraph).toMatchObject({ url: 'https://announce.example/archive', siteName: SITE_NAME });
    expect(home.generateMetadata().twitter).toMatchObject({ card: 'summary_large_image' });
    expect(archive.generateMetadata().twitter).toMatchObject({ card: 'summary_large_image' });
  });

  // A page that sets its own openGraph replaces the layout's, and the root
  // app/opengraph-image.png then no longer reaches it (seen on /archive), so
  // the site image is named explicitly.
  it('archive names the site image for og and twitter', async () => {
    const archive = await import('../app/archive/page.js');
    const m = archive.generateMetadata();
    expect(m.openGraph).toMatchObject({ images: [SITE_IMG] });
    expect(m.twitter).toMatchObject({ images: [SITE_IMG] });
  });
});

// Plain static files under public/, named explicitly in metadata: no image
// depends on Next's opengraph-image file convention (a prerendered route under
// a dynamic segment is served from the runtime's own manifest).
describe('preview image files', () => {
  it('site image is a 1200 x 630 opaque PNG in public/brand', () => {
    const s = pngSize(join(ROOT, 'public', 'brand', 'og-site.png'));
    expect([s.w, s.h, s.colorType]).toEqual([1200, 630, 2]);
  });
  it('announcement image is a 600 x 600 opaque PNG in public/brand', () => {
    const s = pngSize(join(ROOT, 'public', 'brand', 'og-announcement.png'));
    expect([s.w, s.h, s.colorType]).toEqual([600, 600, 2]);
  });
  it('no opengraph-image / twitter-image file convention is left in app/', () => {
    for (const f of ['opengraph-image.png', 'twitter-image.png', 'a/[slug]/opengraph-image.png', 'a/[slug]/twitter-image.png']) {
      expect(existsSync(join(ROOT, 'app', f)), f).toBe(false);
    }
  });
});

describe('/a/[slug] page metadata (database)', () => {
  let sql: Sql;
  const savedDb = process.env.DATABASE_URL;
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    sql = await testSql();
  });
  beforeEach(async () => { await resetDb(sql); });
  afterAll(async () => {
    await sql.end();
    const g = globalThis as unknown as { __announceSql?: Sql };
    await g.__announceSql?.end();
    g.__announceSql = undefined;
    if (savedDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDb;
  });

  const input = (severity: Severity): AnnouncementInput => ({
    type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity,
    title: `Page ${severity}`, bodyMd: 'Operators must act.', actionsRequired: [], links: [],
  });

  for (const sev of ['critical', 'recommended', 'info'] as const) {
    it(`${sev}: generateMetadata + generateViewport use the published row`, async () => {
      process.env.PUBLIC_BASE_URL = 'https://announce.example';
      const d = await createDraft(sql, input(sev), 'a@x');
      const r = await requestPublish(sql, d.id, 'a@x');
      const p = r.status === 'publish_requested' ? await confirmPublish(sql, d.id, 'b@x') : r;
      const page = await import('../app/a/[slug]/page.js');
      const params = Promise.resolve({ slug: p.slug });
      const m = await page.generateMetadata({ params });
      expect(m.openGraph).toMatchObject({ url: `https://announce.example/a/${p.slug}`, title: `Page ${sev}` });
      expect(m.twitter).toMatchObject({ card: 'summary' });
      expect(await page.generateViewport({ params: Promise.resolve({ slug: p.slug }) }))
        .toEqual({ themeColor: SEVERITY_EMBED_COLOR[sev] });
    });
  }

  it('unknown slug: no announcement metadata and no theme-color', async () => {
    const page = await import('../app/a/[slug]/page.js');
    expect(await page.generateMetadata({ params: Promise.resolve({ slug: 'nope' }) })).toEqual({});
    expect(await page.generateViewport({ params: Promise.resolve({ slug: 'nope' }) })).toEqual({});
  });
});

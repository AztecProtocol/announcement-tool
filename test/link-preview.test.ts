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
    expect(m.openGraph).toMatchObject({ type: 'website', siteName: SITE_NAME });
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
    const img = { url: '/opengraph-image.png', width: 1200, height: 630, type: 'image/png' };
    expect(m.openGraph).toMatchObject({ images: [img] });
    expect(m.twitter).toMatchObject({ images: [img] });
  });
});

describe('preview image files', () => {
  it('site image is 1200 x 630 PNG next to the root layout', () => {
    const s = pngSize(join(ROOT, 'app', 'opengraph-image.png'));
    expect([s.w, s.h]).toEqual([1200, 630]);
  });
  it('announcement image is 600 x 600 PNG in the /a/[slug] route', () => {
    const s = pngSize(join(ROOT, 'app', 'a', '[slug]', 'opengraph-image.png'));
    expect([s.w, s.h]).toEqual([600, 600]);
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

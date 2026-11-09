import { describe, it, expect } from 'vitest';
import { buildJsonFeed, buildAtomFeed } from '../src/core/feeds.js';
import type { Announcement } from '../src/core/types.js';

const ann: Announcement = {
  id: 'ann_F', revision: 1, slug: 'slug-f', type: 'upgrade', networks: ['mainnet'],
  audiences: ['operators'], severity: 'critical', title: 'Upgrade & restart <now>',
  bodyMd: 'Do it **now**.', actionsRequired: [], links: [], status: 'published',
  createdBy: 'a@x', publishedAt: '2026-08-06T10:00:00.000Z',
};

describe('feeds', () => {
  it('builds a JSON Feed 1.1 with canonical urls and html content', () => {
    const feed = buildJsonFeed([ann]) as Record<string, unknown>;
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    const items = feed.items as Array<Record<string, unknown>>;
    expect(items[0].id).toBe('ann_F');
    expect(items[0].url).toBe('https://announce.aztec.network/a/slug-f');
    expect(items[0].title).toBe('[MAINNET] [CRITICAL] [UPGRADE] Upgrade & restart <now>');
    expect(items[0].content_html).toContain('<b>now</b>');
    expect(items[0].date_published).toBe('2026-08-06T10:00:00.000Z');
  });

  it('carries no event-handler attribute from a hostile body', () => {
    const hostile = {
      ...ann,
      bodyMd: '[x](https://e.com/"onfocus="alert(document.domain)"autofocus=")',
    };
    const feed = buildJsonFeed([hostile]) as Record<string, unknown>;
    const items = feed.items as Array<Record<string, unknown>>;
    const html = items[0].content_html as string;
    const tags = (html.match(/<[a-zA-Z][^>]*>/g) ?? []).filter(t => /\son[a-z]+\s*=/i.test(t));
    expect(tags).toEqual([]);
    expect(html).not.toContain('"onfocus');
    expect(buildAtomFeed([hostile])).not.toContain('"onfocus');
  });

  it('builds Atom with XML-escaped titles and content', () => {
    const xml = buildAtomFeed([ann]);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('Upgrade &amp; restart &lt;now&gt;');
    expect(xml).toContain('<id>urn:aztec-announce:ann_F</id>');
    expect(xml).toContain('href="https://announce.aztec.network/a/slug-f"');
    expect(xml).not.toContain('<b>now</b>'); // html content must be escaped inside the XML
  });

  it('empty feed is still valid', () => {
    const xml = buildAtomFeed([]);
    expect(xml).toContain('</feed>');
    expect((buildJsonFeed([]) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('feed icons', () => {
  const ICON = 'https://announce.aztec.network/brand/feed-icon-512.png';
  const FAVICON = 'https://announce.aztec.network/brand/feed-icon-64.png';

  it('JSON Feed 1.1 carries top-level icon (512 px) and favicon (64 px) as absolute URLs', () => {
    const feed = buildJsonFeed([ann]) as Record<string, unknown>;
    expect(feed.icon).toBe(ICON);
    expect(feed.favicon).toBe(FAVICON);
    // JSON Feed 1.1 top-level keys only (no misspelt or 1.0-only fields)
    const allowed = ['version', 'title', 'home_page_url', 'feed_url', 'description', 'user_comment',
      'next_url', 'icon', 'favicon', 'authors', 'language', 'expired', 'hubs', 'items'];
    expect(Object.keys(feed).filter(k => !allowed.includes(k))).toEqual([]);
  });

  it('Atom has exactly one <icon> and one <logo>, children of <feed> before the first <entry>', () => {
    const xml = buildAtomFeed([ann]);
    expect(xml.match(/<icon>/g)).toHaveLength(1);
    expect(xml.match(/<logo>/g)).toHaveLength(1);
    expect(xml).toContain(`  <icon>${FAVICON}</icon>`);
    expect(xml).toContain(`  <logo>${ICON}</logo>`);
    const firstEntry = xml.indexOf('<entry>');
    expect(xml.indexOf('<icon>')).toBeLessThan(firstEntry);
    expect(xml.indexOf('<logo>')).toBeLessThan(firstEntry);
    expect(xml.indexOf('<icon>')).toBeGreaterThan(xml.indexOf('<feed '));
  });

  it('follows PUBLIC_BASE_URL', () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://feeds.example/';
    try {
      expect((buildJsonFeed([]) as Record<string, unknown>).icon).toBe('https://feeds.example/brand/feed-icon-512.png');
      expect(buildAtomFeed([])).toContain('<icon>https://feeds.example/brand/feed-icon-64.png</icon>');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it('icon files exist: square opaque PNGs of the stated size', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const [f, n] of [['feed-icon-512.png', 512], ['feed-icon-64.png', 64]] as const) {
      const b = readFileSync(join(__dirname, '..', 'public', 'brand', f));
      expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([n, n]);
      expect(b[25]).toBe(2); // colour type 2 = RGB, no alpha
    }
  });
});

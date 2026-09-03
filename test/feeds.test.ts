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

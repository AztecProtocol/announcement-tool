import type { Announcement } from './types.js';
import { canonicalUrl, tagLine, renderBodyHtml } from './render.js';
import { publicBaseUrl } from './public-base-url.js';

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function baseUrl(): string {
  return publicBaseUrl();
}

// Feed-reader icons: Paper symbol on a full-bleed Ink square (opaque PNG).
// 512 px = JSON Feed `icon` / Atom `<logo>`; 64 px = JSON Feed `favicon` /
// Atom `<icon>`. PNG rather than the SVG favicon: many readers ignore SVG.
const feedIcon = () => `${baseUrl()}/brand/feed-icon-512.png`;
const feedFavicon = () => `${baseUrl()}/brand/feed-icon-64.png`;

export function buildJsonFeed(items: Announcement[]): object {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Aztec release announcements',
    home_page_url: baseUrl(),
    feed_url: `${baseUrl()}/feed.json`,
    icon: feedIcon(),
    favicon: feedFavicon(),
    items: items.map(a => ({
      id: a.id,
      url: canonicalUrl(a),
      title: `${tagLine(a)} ${a.title}`,
      content_html: renderBodyHtml(a.bodyMd),
      date_published: a.publishedAt,
    })),
  };
}

export function buildAtomFeed(items: Announcement[]): string {
  const updated = items[0]?.publishedAt ?? new Date(0).toISOString();
  const entries = items.map(a => [
    '  <entry>',
    `    <id>urn:aztec-announce:${a.id}</id>`,
    `    <title>${xmlEscape(`${tagLine(a)} ${a.title}`)}</title>`,
    `    <link href="${xmlEscape(canonicalUrl(a))}"/>`,
    `    <updated>${a.publishedAt ?? updated}</updated>`,
    `    <content type="html">${xmlEscape(renderBodyHtml(a.bodyMd))}</content>`,
    '  </entry>',
  ].join('\n')).join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${baseUrl()}/</id>`,
    '  <title>Aztec release announcements</title>',
    `  <updated>${updated}</updated>`,
    `  <link href="${baseUrl()}/feed.atom" rel="self"/>`,
    `  <link href="${baseUrl()}/"/>`,
    `  <icon>${xmlEscape(feedFavicon())}</icon>`,
    `  <logo>${xmlEscape(feedIcon())}</logo>`,
    entries,
    '</feed>',
  ].join('\n');
}

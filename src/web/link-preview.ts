// Link-preview metadata (Open Graph / Twitter card) and the severity-coloured
// embed bar that chat clients (Discord, Slack, …) draw from <meta name="theme-color">.
//
// The images themselves are static files picked up through Next's file
// convention: app/opengraph-image.png (site, 1200 x 630) and
// app/a/[slug]/opengraph-image.png (every announcement, 600 x 600 square).
// Next turns them into absolute og:image URLs through the root layout's
// metadataBase (PUBLIC_BASE_URL).

import type { Metadata, Viewport } from 'next';
import type { Announcement, Severity } from '../core/types.js';
import { canonicalUrl } from '../core/render.js';
import { publicBaseUrl } from '../core/public-base-url.js';

export const SITE_NAME = 'announce.aztec.network';
export const SITE_TITLE = 'Aztec release announcements';
export const SITE_DESCRIPTION = 'Upgrades, governance events and operational notices for Aztec operators.';

/**
 * Embed-bar colours for DARK chat backgrounds (Discord's #2b2d31 embed), sent
 * as theme-color on announcement pages. Lighter than the site's severity
 * tokens on purpose so the 4 px bar reads on dark grey. NOT for use on Paper:
 * on the site and in email the severity colours stay #a8180f / #7a5a06 / #12405e.
 */
export const SEVERITY_EMBED_COLOR: Readonly<Record<Severity, string>> = {
  critical: '#e0362b',
  recommended: '#d9a21b',
  info: '#3b82c4',
};

const SUMMARY_MAX = 200;
const HEADING = /^\s{0,3}#{1,6}\s/;

/** First prose paragraph of the markdown body as plain text, at most 200 chars. */
export function announcementSummary(md: string): string {
  const paragraphs = md.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const prose = para.split('\n').filter(l => !HEADING.test(l)).join(' ');
    const text = prose
      .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (text.length <= SUMMARY_MAX) return text;
    const cut = text.slice(0, SUMMARY_MAX - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > 0 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return '';
}

export function announcementMetadata(a: Announcement): Metadata {
  const description = announcementSummary(a.bodyMd) || SITE_DESCRIPTION;
  return {
    title: a.title,
    description,
    openGraph: {
      type: 'article',
      url: canonicalUrl(a),
      title: a.title,
      description,
      siteName: SITE_NAME,
    },
    // `summary` = small square thumbnail on the right of the embed, so a
    // role-pinged critical post does not get a large picture under it.
    twitter: { card: 'summary', title: a.title, description },
  };
}

export function announcementViewport(a: Announcement): Viewport {
  return { themeColor: SEVERITY_EMBED_COLOR[a.severity] };
}

// The root app/opengraph-image.png, named explicitly. A page that sets its own
// openGraph/twitter replaces the layout's, and the file-convention image of
// the root segment then no longer reaches it (it did not on /archive).
const SITE_IMAGE = { url: '/opengraph-image.png', width: 1200, height: 630, type: 'image/png' };

/**
 * Site-level preview. Without a path (root layout) the image comes from the
 * file convention; with a path (a page's own og:url) the image is named.
 */
export function siteMetadata(path?: string): Pick<Metadata, 'openGraph' | 'twitter'> {
  const image = path === undefined ? {} : { images: [SITE_IMAGE] };
  return {
    openGraph: {
      type: 'website',
      ...(path === undefined ? {} : { url: `${publicBaseUrl()}${path}` }),
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      siteName: SITE_NAME,
      ...image,
    },
    twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION, ...image },
  };
}

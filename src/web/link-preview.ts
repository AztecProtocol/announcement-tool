// Link-preview metadata (Open Graph / Twitter card) and the severity-coloured
// embed bar that chat clients (Discord, Slack, …) draw from <meta name="theme-color">.
//
// The images are plain static files in public/brand, named explicitly here
// (not Next's opengraph-image file convention, whose route under the dynamic
// /a/[slug] segment is a prerendered entry the hosting runtime must resolve
// from its own manifest). Next makes the relative URLs absolute through the
// root layout's metadataBase (PUBLIC_BASE_URL).

import type { Metadata, Viewport } from 'next';
import type { Announcement, Severity } from '../core/types.js';
import { canonicalUrl, HEADING_RE, MD_LINK_RE } from '../core/render.js';
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

// Static images in public/brand (made by scripts/brand-images/).
const SITE_IMAGE = { url: '/brand/og-site.png', width: 1200, height: 630, type: 'image/png' };
const ANNOUNCEMENT_IMAGE = { url: '/brand/og-announcement.png', width: 600, height: 600, type: 'image/png' };

const SUMMARY_MAX = 200; // code points, ellipsis included

// Paragraphs that are not prose for a preview: a code fence, an HTML comment
// or a quote. (The page shows them as literal text; a preview should not
// lead with them.)
const NOT_PROSE = /^(```|<!--|>)/;

/**
 * First prose paragraph of the markdown body as plain text, at most 200 code
 * points. Uses the renderer's own heading and link rules (HEADING_RE,
 * MD_LINK_RE), so the text matches what /a/<slug> shows: a link becomes its
 * label, a non-http link stays literal, a lone "#" line is text.
 */
export function announcementSummary(md: string): string {
  for (const para of md.split(/\n{2,}/)) {
    if (NOT_PROSE.test(para.trim())) continue;
    const prose = para.split('\n').filter(l => !HEADING_RE.test(l)).join(' ');
    const text = prose
      .replace(MD_LINK_RE, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    // Cut by code points, not UTF-16 units, so an emoji or an astral CJK
    // character is never split into a lone surrogate.
    const chars = Array.from(text);
    if (chars.length <= SUMMARY_MAX) return text;
    const cut = chars.slice(0, SUMMARY_MAX - 1).join('');
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
      images: [ANNOUNCEMENT_IMAGE],
    },
    // `summary` = small square thumbnail on the right of the embed, so a
    // role-pinged critical post does not get a large picture under it.
    twitter: { card: 'summary', title: a.title, description, images: [ANNOUNCEMENT_IMAGE] },
  };
}

export function announcementViewport(a: Announcement): Viewport {
  return { themeColor: SEVERITY_EMBED_COLOR[a.severity] };
}

/**
 * Site-level preview: home, archive, and (through the root layout) every page
 * without its own, the 404 page included. Pass a path for a page's own og:url.
 */
export function siteMetadata(path?: string): Pick<Metadata, 'openGraph' | 'twitter'> {
  const image = { images: [SITE_IMAGE] };
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

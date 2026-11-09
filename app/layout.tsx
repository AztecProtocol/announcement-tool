import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DEFAULT_PUBLIC_BASE_URL, publicBaseUrl } from '../src/core/public-base-url.js';
import { SITE_DESCRIPTION, SITE_TITLE, siteMetadata } from '../src/web/link-preview.js';
import './globals.css';

// Favicon and apple-touch icon come from the file conventions next to this
// layout (app/icon.svg, app/apple-icon.png); no `icons` override here, or it
// would replace them. metadataBase is read per request so that any absolute
// metadata URL Next writes points at PUBLIC_BASE_URL, not the request host.
// The site link-preview image is app/opengraph-image.png (file convention);
// /a/[slug] replaces it with its own square image and a severity theme-color.
// No theme-color here: only announcement pages carry one.
export function generateMetadata(): Metadata {
  return {
    metadataBase: metadataBase(),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    ...siteMetadata(),
  };
}

// A PUBLIC_BASE_URL that does not parse ('' or 'https://') must not take
// every page down with a TypeError from `new URL`; fall back to the default
// host for metadata only. publicBaseUrl() itself is unchanged for its other
// callers, and the production checks still refuse a missing or non-https value.
function metadataBase(): URL {
  try {
    return new URL(publicBaseUrl());
  } catch {
    return new URL(DEFAULT_PUBLIC_BASE_URL);
  }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          {/* Ink wordmark on the Paper ground, per the brand's two-version rule. */}
          <a href="/" className="brand" aria-label="Aztec release announcements — home">
            <img src="/brand/aztec-wordmark-ink.svg" alt="Aztec" width={104} height={24} />
          </a>
          <nav>
            <a href="/archive">Archive</a>
            <a href="/docs/webhooks">Webhook docs</a>
            <a href="/feed.atom">Feed</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>Announcements for Aztec operators and ecosystem teams.</p>
        </footer>
      </body>
    </html>
  );
}

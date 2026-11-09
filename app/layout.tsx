import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { publicBaseUrl } from '../src/core/public-base-url.js';
import './globals.css';

// Favicon and apple-touch icon come from the file conventions next to this
// layout (app/icon.svg, app/apple-icon.png); no `icons` override here, or it
// would replace them. metadataBase is read per request so that any absolute
// metadata URL Next writes points at PUBLIC_BASE_URL, not the request host.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(publicBaseUrl()),
    title: 'Aztec release announcements',
    description: 'Upgrades, governance events and operational notices for Aztec operators.',
  };
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

import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Aztec release announcements',
  description: 'Upgrades, governance events and operational notices for Aztec operators.',
  icons: { icon: '/brand/aztec-symbol.png' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          {/* Ink wordmark on the Parchment ground, per the brand's two-version rule. */}
          <a href="/" className="brand" aria-label="Aztec release announcements — home">
            <img src="/brand/aztec-wordmark-ink.svg" alt="Aztec" width={101} height={26} />
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

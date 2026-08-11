import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Aztec release announcements',
  description: 'Upgrades, governance events and operational notices for Aztec operators — release-only, no noise.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a href="/" className="brand">Aztec release announcements</a>
          <nav>
            <a href="/archive">Archive</a>
            <a href="/docs/webhooks">Webhook docs</a>
            <a href="/feed.atom">Feed</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>Release-only announcements for Aztec operators and ecosystem teams. Subscribing is optional — everything here is public.</p>
        </footer>
      </body>
    </html>
  );
}

import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { resolveIdentity, listPublishers } from '../../src/core/identity.js';
import { getDb } from '../../src/web/db.js';

export const metadata = {
  title: 'Admin — Aztec release announcements',
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const identity = resolveIdentity(await headers());

  if (!identity) {
    return (
      <main>
        <h1>Admin access requires the Aztec tailnet</h1>
        <p className="muted">
          This page is reachable only over the Foundation tailnet. Join the tailnet and reload.
        </p>
      </main>
    );
  }

  const publishers = await listPublishers(getDb());
  const bootstrapping = publishers.length === 0;
  const sourceLabel = identity.source === 'tailscale' ? 'tailnet' : 'dev';

  return (
    <div>
      <div className="admin-identity-bar">
        <span>{identity.email}</span>
        <span className="tag tag-info">{sourceLabel}</span>
      </div>
      {bootstrapping && (
        <div className="notice">
          <p>
            No publishers configured — anyone reaching this page can publish. Add publishers before launch.
          </p>
        </div>
      )}
      <main>{children}</main>
    </div>
  );
}

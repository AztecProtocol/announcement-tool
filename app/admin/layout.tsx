import type { ReactNode } from 'react';
// Deep import, not `next/headers`: see the `paths` comment in tsconfig.json —
// mapping the `next/headers` specifier (any form) makes Turbopack's dev
// resolver silently bind the import to `undefined` at runtime, even though it
// type-checks. This path is what `next/headers` re-exports from anyway.
import { headers } from 'next/dist/server/request/headers.js';
import { resolveIdentity, listPublishers } from '../../src/core/identity.js';
import { getDb } from '../../src/web/db.js';

export const metadata = {
  title: 'Admin — Aztec release announcements',
};

export const dynamic = 'force-dynamic';

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

  // Invariant: identity resolution failing OR publisher lookup failing must both
  // prevent children rendering. The identity check above fails closed by returning
  // early. This one fails closed explicitly: if we can't verify who is allowed to
  // publish, we must not render admin children — a future refactor that wraps this
  // in a broader try/catch must not swallow this and fall through with a default.
  let publishers: string[];
  try {
    publishers = await listPublishers(getDb());
  } catch {
    return (
      <main>
        <h1>Admin is unavailable</h1>
        <p className="muted">Could not verify publisher configuration.</p>
      </main>
    );
  }
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

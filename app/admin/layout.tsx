import type { ReactNode } from 'react';
// Deep import, not `next/headers`. The public specifier does not type-check
// under TS7/NodeNext, and mapping it in tsconfig `paths` makes Turbopack
// resolve the RUNTIME import to a .d.ts (no exports) — `(void 0) is not a
// function`. This is the module `next/headers` itself re-exports. Full
// reasoning and the re-verification steps are in tsconfig.json's paths comment.
import { headers } from 'next/dist/server/request/headers.js';
import { resolveIdentity, listPublishers, isPublisher } from '../../src/core/identity.js';
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
  //
  // This gates READ access too, not just the mutating server actions in
  // app/admin/actions.ts: without it, any tailnet identity that resolves but
  // isn't a publisher could still read draft bodies, requester emails, fan-out
  // targets, and template names simply by loading /admin or /admin/review/<id>.
  let publishers: string[];
  let allowed: boolean;
  try {
    publishers = await listPublishers(getDb());
    allowed = await isPublisher(getDb(), identity.email);
  } catch {
    return (
      <main>
        <h1>Admin is unavailable</h1>
        <p className="muted">Could not verify publisher configuration.</p>
      </main>
    );
  }
  if (!allowed) {
    return (
      <main>
        <h1>Admin access requires publisher permissions</h1>
        <p className="muted">
          This identity ({identity.email}) is not in the publishers list. Ask an existing publisher to add you.
        </p>
      </main>
    );
  }
  const bootstrapping = publishers.length === 0;
  const sourceLabel = identity.source === 'tailscale' ? 'tailnet' : 'dev';

  return (
    <div>
      <header className="site-header">
        <a href="/admin" className="brand" aria-label="Admin — Aztec release announcements — home">
          <img src="/brand/aztec-wordmark-ink.svg" alt="Aztec" width={101} height={26} />
        </a>
        <nav>
          <a href="/admin">Admin</a>
          <a href="/archive">Archive</a>
          <a href="/">Public site</a>
        </nav>
      </header>
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

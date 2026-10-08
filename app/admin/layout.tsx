import type { ReactNode } from 'react';
// Deep import, not `next/headers`. The public specifier does not type-check
// under TS7/NodeNext, and mapping it in tsconfig `paths` makes Turbopack
// resolve the RUNTIME import to a .d.ts (no exports) — `(void 0) is not a
// function`. This is the module `next/headers` itself re-exports. Full
// reasoning and the re-verification steps are in tsconfig.json's paths comment.
import { headers } from 'next/dist/server/request/headers.js';
import { resolveIdentity } from '../../src/core/identity.js';
import { checksApply, guardEnvFromProcess } from '../../src/core/production-guard.js';
import { getDb } from '../../src/web/db.js';
import { requirePublisher } from '../../src/web/admin-gate.js';

export const metadata = {
  title: 'Admin — Aztec release announcements',
};

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Invariant: identity resolution failing OR publisher lookup failing must both
  // prevent children rendering. requirePublisher (src/web/admin-gate.ts) is the
  // one place that decides, and it fails closed: no identity, not a publisher,
  // or any error while checking is a refusal, and each refusal returns early
  // below. A future refactor that wraps this in a broader try/catch must not
  // swallow a refusal and fall through with a default.
  //
  // requirePublisher gates READ access too, not just the mutating server
  // actions in app/admin/actions.ts: draft bodies, requester emails, fan-out
  // targets, and template names. But the call in this layout does not protect
  // those reads, because the pages do them, not the layout.
  //
  // This layout is NOT the check for the pages. It only shows the refusal. Next
  // renders the page segment even when this layout does not return `children`,
  // so every page.tsx under app/admin calls requirePublisher itself before it
  // reads anything (test/admin-pages-gated.test.ts is a text check for that).
  const reqHeaders = await headers();
  const gate = await requirePublisher(getDb(), reqHeaders);

  if (!gate.ok && gate.reason === 'no-identity') {
    if (process.env.DEPLOY_TARGET === 'netlify') {
      return (
        <div>
          <h1>Admin sign-in required</h1>
          <p className="muted">
            <a href="/admin/login">Sign in with Google</a>
          </p>
        </div>
      );
    }
    return (
      <div>
        <h1>Admin access requires the Aztec tailnet</h1>
        <p className="muted">
          This page is reachable only over the Foundation tailnet. Join the tailnet and reload.
        </p>
      </div>
    );
  }

  if (!gate.ok && gate.reason === 'unavailable') {
    return (
      <div>
        <h1>Admin is unavailable</h1>
        <p className="muted">Could not verify publisher configuration.</p>
      </div>
    );
  }
  if (!gate.ok) {
    // Display only: the gate has already refused. The email is read again
    // from the same headers because the refusal does not carry it.
    const refused = resolveIdentity(reqHeaders);
    return (
      <div>
        <h1>Admin access requires publisher permissions</h1>
        <p className="muted">
          This identity ({refused?.email}) is not in the publishers list. Ask an existing publisher to add you.
        </p>
      </div>
    );
  }
  const { identity, publishers } = gate;
  // isPublisher already denied an empty table on a deployed instance, so this
  // notice can only be reached in insecure local development. Say so explicitly.
  const bootstrapping = publishers.length === 0 && !checksApply(guardEnvFromProcess());
  const sourceLabel = { auth0: 'google', tailscale: 'tailnet', dev: 'dev' }[identity.source];
  // Only a browser session can be ended. A tailnet or dev identity comes with
  // every request, so a sign-out link there would do nothing.
  const canSignOut = identity.source === 'auth0';

  return (
    <div>
      <div className="admin-identity-bar">
        <span>{identity.email}</span>
        <span className="tag tag-info">{sourceLabel}</span>
        {/* Only the admin home. Archive and the public site are already one
            click away in the site header directly above this bar, so
            repeating them here is noise. */}
        <nav className="admin-identity-nav">
          <a href="/admin">Admin</a>
          {canSignOut && <a href="/admin/logout">Sign out</a>}
        </nav>
      </div>
      {bootstrapping && (
        <div className="notice">
          <p>
            No publishers configured — anyone reaching this page can publish. Add publishers before launch.
          </p>
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

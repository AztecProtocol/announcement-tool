// Deep import, not `next/server` — see tsconfig.json's paths comment.
import { connection } from 'next/dist/server/request/connection.js';

export const metadata = {
  title: 'Page not found — Aztec release announcements',
};

/**
 * Replaces Next's built-in 404 page, which is prerendered at build time.
 *
 * A prerendered page cannot carry the per-request CSP nonce, so under
 * `CSP_MODE=enforce` every script on the built-in page is blocked: React never
 * hydrates, and each 404 posts a violation report for every blocked script. A
 * crawler or a scan walking missing paths would bury real violations under
 * that noise. `connection()` opts this page into per-request rendering, so its
 * scripts are stamped like every other page's.
 */
export default async function NotFound() {
  await connection();
  return (
    <>
      <h1>Page not found</h1>
      <p>This page does not exist. It may have been moved, or the link may be wrong.</p>
      <p className="muted">
        Go to the <a href="/">subscribe page</a>, or browse the <a href="/archive">archive</a>.
      </p>
    </>
  );
}

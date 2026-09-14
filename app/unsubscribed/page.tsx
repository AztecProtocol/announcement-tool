// Deep import, not `next/server` — see tsconfig.json's paths comment.
import { connection } from 'next/dist/server/request/connection.js';

export default async function UnsubscribedPage() {
  // This page was prerendered at build time. The CSP nonce is generated per
  // request, so a page rendered once at build time would ship a stale nonce or
  // none at all; `connection()` opts it into per-request rendering.
  await connection();
  return (
    <>
      <h1>Unsubscribed</h1>
      <p>You will receive no further announcements.</p>
    </>
  );
}

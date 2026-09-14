// Deep import, not `next/server` — see tsconfig.json's paths comment.
import { connection } from 'next/dist/server/request/connection.js';

export default async function SubscribedPage() {
  // This page was prerendered at build time. The CSP nonce is generated per
  // request, so a page rendered once at build time would ship a stale nonce or
  // none at all; `connection()` opts it into per-request rendering.
  await connection();
  return (
    <>
      <h1>Check your inbox</h1>
      <p>If this address wasn't already confirmed, we've sent a confirmation link. Nothing will be delivered until it's clicked.</p>
      <p className="muted">Already confirmed? Your preferences were updated instead.</p>
    </>
  );
}

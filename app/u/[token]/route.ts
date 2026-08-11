import { getDb } from '../../../src/web/db.js';
import { unsubscribeByToken } from '../../../src/core/tokens-flow.js';

export const dynamic = 'force-dynamic';

// GET (human click-through, confirm-button page) and POST (RFC 8058
// List-Unsubscribe-Post one-click) must share this exact URL: it's the same
// link the email footer and the List-Unsubscribe header both point at
// (src/adapters/email.ts unsubscribeUrl). Next.js App Router forbids a
// page.tsx and route.ts coexisting in the same segment, so both verbs are
// implemented here instead of splitting into page.tsx + route.ts.
function confirmPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Unsubscribe — Aztec release announcements</title></head>
<body>
<h1>Unsubscribe</h1>
<p>Stop receiving Aztec release announcements at this address?</p>
<form method="post" action="/u/${token}">
  <button type="submit">Unsubscribe</button>
</form>
<p><a href="/manage/${token}">or change preferences instead</a></p>
</body>
</html>`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return new Response(confirmPage(token), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// RFC 8058 §3.1: the response to a one-click POST MUST NOT be an HTTPS
// redirect, so this always returns a bare 200 — both for mail-client
// one-click POSTs and for the human confirm-button form submit above.
// The confirm page could add a JS-driven redirect to /unsubscribed, but
// that's cosmetic polish, not required by the brief or RFC 8058.
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  await unsubscribeByToken(getDb(), token);
  return new Response('Unsubscribed', { status: 200 });
}

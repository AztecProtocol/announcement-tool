import { getDb } from '../../../src/web/db.js';
import { unsubscribeByToken } from '../../../src/core/tokens-flow.js';
import {
  isValidToken, renderConfirmPage, renderInvalidTokenPage, isOneClickBody,
} from '../../../src/web/unsubscribe-html.js';

export const dynamic = 'force-dynamic';

// GET (human click-through, confirm-button page) and POST (RFC 8058
// List-Unsubscribe-Post one-click) must share this exact URL: it's the same
// link the email footer and the List-Unsubscribe header both point at
// (src/adapters/email.ts unsubscribeUrl). Next.js App Router forbids a
// page.tsx and route.ts coexisting in the same segment, so both verbs are
// implemented here instead of splitting into page.tsx + route.ts.
//
// POST has two distinct callers sharing this one URL:
//   - mail clients doing RFC 8058 one-click send body `List-Unsubscribe=One-Click`
//     and MUST NOT be redirected (RFC 8058 §3.1) — they get a bare 200.
//   - the confirm-page form below sends `confirm=1` and is a normal browser
//     navigation — it gets unsubscribed and 303-redirected to /unsubscribed.
// HTML building and token validation live in src/web/unsubscribe-html.ts so
// they're unit-testable without booting Next (see test/unsubscribe-html.test.ts).

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!isValidToken(token)) return html(renderInvalidTokenPage(), 404);
  return html(renderConfirmPage(token));
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!isValidToken(token)) return html(renderInvalidTokenPage(), 404);

  const body = await req.text();
  await unsubscribeByToken(getDb(), token);

  if (isOneClickBody(body)) {
    // RFC 8058 §3.1: MUST NOT redirect the one-click response.
    return new Response('Unsubscribed', { status: 200 });
  }
  return new Response(null, { status: 303, headers: { location: '/unsubscribed' } });
}

// Pure, framework-free helpers for the /u/[token] confirm page.
//
// Extracted out of app/u/[token]/route.ts so the HTML-building and token
// validation can be unit-tested without booting Next.js.

/** unsubscribe/verify tokens are `randomBytes(16).toString('hex')` — see src/core/ids.ts newToken(). */
export function isValidToken(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Minimal inline styles mirroring app/globals.css so this route-handler page
// (see route.ts for why it can't be a page.tsx) looks intentional rather than
// bare. Not the real stylesheet — just enough to match the site's look.
const INLINE_STYLE = `
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:#faf9f7;color:#22201d;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:720px;margin:0 auto;padding:32px 20px 80px}
  .site-header{max-width:720px;margin:0 auto;padding:20px;border-bottom:1px solid #e0dcd5;font-weight:700}
  h1{font-size:26px;line-height:1.2;letter-spacing:-0.01em}
  a{color:#3a5a78}
  button{font:inherit;font-weight:600;padding:9px 18px;border-radius:7px;border:1px solid #3a5a78;background:#3a5a78;color:#fff;cursor:pointer}
`;

/**
 * Renders the human-facing confirm page for a token that has already been
 * validated with isValidToken(). Interpolated values are also HTML-escaped
 * as belt-and-suspenders even though a shape-validated token is hex-only
 * and therefore inert.
 */
export function renderConfirmPage(token: string): string {
  const t = escapeHtml(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe — Aztec release announcements</title>
  <style>${INLINE_STYLE}</style>
</head>
<body>
<header class="site-header">Aztec release announcements</header>
<main>
  <h1>Unsubscribe</h1>
  <p>Stop receiving Aztec release announcements at this address?</p>
  <form method="post" action="/u/${t}">
    <input type="hidden" name="confirm" value="1">
    <button type="submit">Unsubscribe</button>
  </form>
  <p><a href="/manage/${t}">or change preferences instead</a></p>
</main>
</body>
</html>`;
}

/** Generic page for a malformed or unrecognized token — never echoes the input. */
export function renderInvalidTokenPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link not recognized — Aztec release announcements</title>
  <style>${INLINE_STYLE}</style>
</head>
<body>
<header class="site-header">Aztec release announcements</header>
<main>
  <h1>Link not recognized</h1>
  <p>This link is invalid or the subscription no longer exists.</p>
</main>
</body>
</html>`;
}

/** RFC 8058 one-click POSTs carry this exact body; distinguishes them from the human confirm-form POST above. */
export function isOneClickBody(body: string): boolean {
  return body.trim() === 'List-Unsubscribe=One-Click';
}

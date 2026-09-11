# aztec-announce (announcement-tool) — security properties spec

**What has already been reviewed.** A threat-modelled security review ran on 2026-09-07 against the code
and the infrastructure. It produced 0 Critical, 3 High, 4 Medium, 6 Low and 5 Informational findings. Every
High and Medium finding is fixed and merged: webhook SSRF (the destination blocklist matched hostname text
and never resolved DNS, so an attacker-controlled name pointing at loopback, the tailnet range or a
metadata address passed — destinations are now resolved, every address is range-checked, and the
connection is pinned to the vetted address), an error oracle that returned upstream status and connection
errors to an anonymous caller, a `fail2ban` log injection that let an attacker have any IP address banned
through the Postgres username, case-sensitive publisher identity that could collapse four-eyes, permanently
replayable email confirmation tokens, no rate limiting on the two public write paths, and missing HTTP
security headers. A follow-up pass on 2026-09-10 verified the eight leads in §6 below and fixed the three
that were actionable. The Low and Informational findings are open. This document supersedes neither review;
it states the properties those reviews were implicitly testing.

Each property is written as: **statement** / where it is enforced / what test covers it / how it breaks.
"Breaks if" is the useful column for a reviewer — it names the change that would silently remove the property.

---

## 1. What the system is

Release-announcement pipeline: an authorised publisher composes an announcement once in a Next.js admin UI,
two publishers approve it when it is `critical`, and a worker fans it out to email, webhook, Discord,
Telegram and Signal subscribers, plus public Atom/JSON feeds and an archive page.

Deployed shape (`DEPLOY_TARGET=netlify`): app + worker on Netlify; a Hetzner VM runs only Postgres, the
Signal sidecar and Caddy. A second supported shape (`DEPLOY_TARGET=vm`) puts the app on a VM behind
Tailscale and takes identity from `Tailscale-User-*` headers. **Only `DEPLOY_TARGET=netlify` is in
scope for review**. The second shape was designed originally, then retired but stayed in the code in case a decision taken to move the entire deployment to a VM instead of Netlify.

## 2. Assets, in the order an attacker would want them

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | **The ability to publish** | This is the point of the system. A forged announcement is an authenticated-looking instruction to every Aztec node operator — "upgrade to this build", "run this command", "the network is halted". This is the crown jewel; everything else is secondary. |
| A2 | **The integrity of a published announcement's content** | Same as A1 in effect: altered body, altered links, altered `actions_required` deadline. |
| A3 | **The webhook signing secrets** (`whsec_…`) | A leaked secret lets an attacker forge announcements *to that consumer's automation* with a valid signature. |
| A4 | **Subscriber list** (email addresses, webhook endpoints) | Operator identities; a leak is both a privacy breach and a target list for phishing that impersonates this exact system. |
| A5 | **Availability of the channel** | If the tool cannot send during an incident, operators do not learn about it. Delivery is the product. |
| A6 | **The app's outbound request capability** | Webhook delivery is a server-side fetch to an attacker-chosen URL: an SSRF primitive pointed at the VM, the tailnet, and cloud metadata. |
| A7 | **Admin session / Auth0 credentials** | Path to A1. |
| A8 | **The database** | Holds A3, A4, the audit log, and publisher list; direct write access is A1. |

## 3. Actors and threat model

Assume every party outside the publisher set is malicious, and that at least one publisher account can be
compromised (that assumption is what four-eyes exists for).

| Actor | Capability assumed |
|-------|--------------------|
| **Anonymous internet** | Any request to the public site and to the app origin directly (Netlify origin is not IP-restricted). Can set any request header, including ones a proxy is expected to set. |
| **Subscriber** | Above, plus possession of their own `verify`, `unsubscribe`, `pending` tokens and (for webhooks) their signing secret. |
| **Compromised single publisher** | Authenticated as one Auth0 identity in the publishers table. Goal: publish a `critical` announcement alone. |
| **Malicious webhook registrant** | Can choose the URL the server will fetch, and re-register it. Goal: SSRF into the VM/tailnet/metadata, or DoS the worker. |
| **Network attacker between app and DB / Signal sidecar** | Goal: read or alter DB traffic (TLS + pinned CA is the control). |
| **Mail-path attacker** | Controls a mail client or an intermediary that prefetches links. Goal: unsubscribe others, or hijack a confirmation link. |

Out of scope for this draft: a compromised Auth0 tenant, a malicious
Netlify or Hetzner, and a compromised publisher *pair* acting in collusion.

## 4. Trust boundaries

1. **Internet → Next.js middleware** (`middleware.ts`). The single boundary for admin identity.
2. **Middleware → app** via the unsigned internal header `AUTH0_IDENTITY_HEADER`. Trusted *only* because
   step 1 of the middleware deletes every inbound copy first, unconditionally.
3. **App → Postgres** (TLS, pinned root certs, `app_role`).
4. **Worker → third-party channel APIs** (Discord/Telegram/Signal/ESP) and **worker → subscriber webhooks**
   (the SSRF boundary, `src/core/safe-url.ts`).
5. **App → Signal sidecar** on the VM (`x-announce-signal-secret` shared secret).
6. **Netlify scheduled/background function → `/tick`** (`src/core/tick-auth.ts` shared secret).

---

## 5. Security properties

### 5.1 Admin identity (A1, A7)

**P1 — No request can assert its own admin identity.**
Every inbound copy of `AUTH0_IDENTITY_HEADER`, `Tailscale-User-Login` and `Tailscale-User-Name` is deleted
before any branch runs.
*Enforced:* `middleware.ts` step 1, unconditional, before any early return.
*Tested:* `test/auth0-claims.test.ts`, `test/identity.test.ts`.
*Breaks if:* any `if`/early return is added above the strip; the middleware `matcher` is narrowed so some
`/admin/*` route is unmatched; a new identity-bearing header is consumed without being added to the strip list.

**P2 — Admin identity comes only from an RS256 JWT verified against the tenant JWKS, or an HS256 cookie this
app minted.**
*Enforced:* `middleware.ts` `bearerIdentity` → `src/core/auth0-verify.ts`; `sessionIdentity` → `src/core/session.ts`.
*Tested:* `test/session.test.ts`, `test/auth0-login.test.ts`.
*Breaks if:* verification is reduced to signature-only (`iss`/`aud`/`exp`/`nbf` must all be enforced — a token
minted for a different app in the same tenant must be rejected); a second copy of the verify logic is
reintroduced in `middleware.ts` and drifts.

**P3 — Missing configuration denies, never permits.** Absent Auth0 config or `SESSION_SECRET` yields no
identity rather than an unverified one.
*Enforced:* `middleware.ts` (`if (!config) return undefined`, `if (!secret) return undefined`).
*Breaks if:* someone "fixes" a broken deployment by treating unset config as dev mode.

**P4 — A weaker credential cannot override a stronger one.** The cookie is consulted only when the bearer
path produced nothing.
*Enforced:* `middleware.ts` `bearerIdentity(...) ?? sessionIdentity(...)`.

**P5 — Login is CSRF- and code-injection-resistant.** Authorization-code + PKCE, with `state` compared in
constant time and the `code_verifier` never leaving a cookie.
*Enforced:* `src/core/auth0-login.ts` (`stateMatches`, S256 challenge).
*Tested:* `test/auth0-login.test.ts`.

**P6 — The session cookie cannot be read by page JS, sent over plaintext, or shadowed.**
`HttpOnly; Secure; SameSite=Lax; Path=/admin`, and the cookie parser takes the *first* occurrence of a name so
an appended duplicate cannot override the real value.
*Enforced:* `app/admin/callback/route.ts` `sessionCookie`, `parseCookies`.

**P7 — Authorization is separate from authentication.** A verified identity still has to be in `publishers`.
*Enforced:* `isPublisher` in `src/core/identity.ts`, called at every admin action entry point (`app/admin/actions.ts`).
*Breaks if:* a new server action is added without the `resolveIdentity` + `isPublisher` pair.

**P8 — A deployed instance never runs with an empty publisher table.** An empty table means "anyone may
publish" (deliberate, for local dev), so a startup assertion refuses to boot in production.
*Enforced:* `src/core/production-guard.ts`; *tested:* `test/production-guard.test.ts`.
*Breaks if:* the permissive branch is folded into `isPublisher` (per-request policy branch), or the guard is
skipped on a new deploy target.

**P9 — Identity comparison is case- and whitespace-insensitive at exactly one place.** Everything downstream
sees one canonical form of "this person".
*Enforced:* `resolveIdentity` normalises; `isPublisher` and the four-eyes checks compare lowercased.
*Breaks if:* a new comparison uses raw `===` on emails — that is a four-eyes bypass (P10) via `Alice@` vs `alice@`.

### 5.2 Publication integrity — four-eyes (A1, A2)

**P10 — A `critical` announcement is published only after two *distinct* publishers act.** The requester
cannot confirm their own request, on either the immediate or the scheduled path.
*Enforced:* `confirmPublish` and `confirmSchedule` in `src/core/announcements.ts` (`FourEyesError`).
*Tested:* `test/publish.test.ts`, `test/scheduling.test.ts`, `test/withdraw-reject.test.ts`.

**P11 — No state transition launders a request into an approval.** `withdrawPublish`, `rejectPublish` and
`cancelSchedule` all return the row to `draft` **and clear** `publish_requested_by` / `publish_confirmed_by`,
so re-publishing needs a fresh request *and* a fresh second confirmation.
*Enforced:* the three functions in `src/core/announcements.ts`.
*Breaks if:* a transition preserves `publish_requested_by` "for convenience".

**P12 — The scheduler approves nothing.** `publishDueScheduled` only takes rows already in `scheduled`, which
is only reachable through the approvals above; the worker cannot move a `draft` or a `publish_requested` row.
*Enforced:* the `status = 'scheduled'` filter.
*Note for reviewers:* `performPublish` overwrites `publish_confirmed_by` with the literal `'scheduler'`; the
humans who approved are preserved only in the `audit_log` detail. **Property to confirm:** the UI and any
export attribute the announcement to the approving humans, not to `scheduler`.

**P13 — Content is immutable once it leaves draft.** `reviseDraft` refuses any status but `draft`; every
mutation targets `(id, latest revision)` under `for update`.
*Breaks if:* `reviseDraft`'s status guard is relaxed — this also silently breaks `publishDueScheduled`'s
"only the latest revision can be `scheduled`" assumption (called out in that function's comment).

**P14 — Concurrent publish attempts cannot double-send.** Row locks (`for update`) on the read-modify-write,
`for update skip locked` on the scheduler and fan-out claims, and a unique constraint on the delivery ledger
with `on conflict do nothing`.
*Enforced:* `src/core/announcements.ts`, `src/core/outbox.ts` `enqueueDeliveries`, `src/worker/fanout.ts`.
*Tested:* `test/fanout.test.ts`, `test/outbox-enablement.test.ts`.

**P15 — Every state change is attributable.** `audit_log` gets a row for create / edit / discard / request /
confirm / withdraw / reject / schedule / cancel / scheduled-send, with actor, target and revision; rows are
never deleted.
*Breaks if:* a new transition is added without its `audit_log` insert.

**P16 — What the confirmation screen shows is what will be sent.** The review screen's target count and the
actual enqueue call the same `countFanoutTargets`.
*Enforced:* `src/core/outbox.ts`; *tested:* `test/preview.test.ts`, `test/channel-preview.test.ts`.

### 5.3 Subscriber consent and tokens (A4)

**P17 — Nothing is delivered to an address that did not confirm it.** Fan-out selects
`subscriptions where verified = true`.
*Enforced:* `countFanoutTargets`; *tested:* `test/subscriptions.test.ts`, `test/subscribe-flow.test.ts`.

**P18 — Subscribing someone else achieves nothing.** An unverified subscription only causes one confirmation
email to the address itself; filters supplied by the requester do not take effect until confirmation.

**P19 — Tokens are unguessable, single-use where they grant a state change, and expiring where they are
credentials-by-email.** `newToken()` = 16 CSPRNG bytes (128 bit); `verify_token` is nulled on use and only
matches within `VERIFY_TOKEN_TTL_HOURS = 72`.
*Enforced:* `src/core/ids.ts`, `src/core/subscriptions.ts`.
*Tested:* `test/tokens-flow.test.ts`, `test/subscribe-flow.test.ts`.

**P20 — A link prefetch cannot unsubscribe anyone.** `GET /u/<token>` renders a confirm page; only `POST`
mutates (RFC 8058 one-click body, or the confirm form).
*Enforced:* `app/u/[token]/route.ts`; *tested:* `test/unsubscribe-html.test.ts`.

**P21 — A webhook secret is shown exactly once and never re-displayed.** `secretOnce` is returned from
registration and not read back.
*Enforced:* `src/core/webhook-flow.ts`.

**P22 — Failure messages do not disclose whether an address or endpoint is already subscribed.** One generic
message on webhook verification failure; the email path returns the same shape for new and existing addresses.
*Enforced:* `src/core/webhook-flow.ts` (`NOT_AUTHORIZED`, `ENDPOINT_NOT_VERIFIED`), `src/core/safe-url.ts`
(`URL_NOT_ALLOWED` — one message for every refusal reason), `app/admin/safe-error-message.ts`.
*Tested:* `test/safe-error-message.test.ts`, `test/webhook-flow.test.ts`.

### 5.4 Outbound requests — SSRF (A6)

**P23 — The server never connects to a non-public address on a subscriber's behalf.** Hostname resolved
first; refused if any resolved address is loopback, link-local, RFC 1918, CGNAT `100.64.0.0/10` (the tailnet
range), multicast, reserved, or IPv6 ULA/link-local, including IPv4-mapped and NAT64 forms; names ending
`localhost`, `.local`, `.internal`, `.home.arpa` refused without resolving.
*Enforced:* `src/core/safe-url.ts` (`isForbiddenHostname`, `resolveDeliverableUrl`); *tested:* `test/safe-url.test.ts`.

**P24 — DNS rebinding cannot beat the check.** The connection is pinned to the vetted addresses via
`pinnedDispatcher`, so an answer that changes between check and connect has no effect. **Every** resolved
address is vetted, not just the first.
*Enforced:* `src/core/safe-url.ts`, `src/adapters/webhook.ts`.

**P25 — Redirects are refused and only `https:` is accepted.** `redirect: 'error'` on the fetch, scheme check
in `assertDeliverableUrl`.

**P26 — A hostile endpoint cannot stall the worker.** 10 s `AbortSignal.timeout`, bounded batch, retry with
backoff, and channel-health detection that marks a target exhausted.
*Enforced:* `src/adapters/webhook.ts`, `src/worker/fanout.ts`, `src/core/health.ts`; *tested:* `test/health.test.ts`, `test/fanout.test.ts`.
*Reviewer note:* confirm the timeout covers body read, not just headers, and that a slow-loris body cannot hold a worker slot.

**P27 — Webhook payloads are authenticated to the consumer.** HMAC-SHA256 over `timestamp.body`, sent as
`x-announce-signature: v1=…`, with `x-announce-event-id` = `<id>.<revision>.<kind>` for replay/idempotency
on the consumer side.
*Enforced:* `src/adapters/webhook.ts` `signPayload`; *tested:* `test/webhook.test.ts`.
*Property the consumer must hold (document it on `/docs/webhooks`):* compare in constant time and reject
timestamps outside a window.

### 5.5 Content handling and injection (A2)

**P28 — Author-supplied markdown cannot execute in any rendering context.** Each channel renderer escapes for
its own target: `&`,`<`,`>` for the Telegram/Discord/email HTML paths, no raw HTML passthrough,
no `dangerouslySetInnerHTML` anywhere in the tree.
*Enforced:* `src/core/render.ts` (`escapeHtml`); *tested:* `test/render.test.ts`, `test/crlf.test.ts`.

**P29 — Link URLs in an announcement cannot become `javascript:`/`data:` in a rendered channel.**
*Reviewer note:* `escapeHtml(l.url)` escapes the value into the attribute but does **not** restrict the
scheme. Confirm scheme validation exists in `src/core/validate.ts` or add it — this is a named property, not
an assertion that it holds.

**P30 — Announcement fields cannot inject headers or control bytes into email/Signal/Telegram payloads.**
CRLF handling is covered by `test/crlf.test.ts`; recipients are never taken from author input.

**P31 — Discord role mentions are constrained to configured role IDs.** An author cannot get `@everyone`
by typing it.
*Enforced:* `src/core/discord-mentions.ts`, `src/core/mentions.ts`; *tested:* `test/discord-mentions.test.ts`, `test/mentions.test.ts`.

**P32 — Public surfaces disclose only published announcements.** Archive, `/a/<slug>`, `feed.atom`,
`feed.json` never expose drafts, discarded items, rejection reasons, subscriber data or actor emails.
*Tested:* `test/feeds.test.ts`, `test/queries.test.ts`. **Confirm the actor-email part explicitly.**

**P33 — All SQL is parameterised.** `postgres` tagged templates throughout; no string-concatenated SQL.

### 5.6 Abuse and availability (A5)

**P34 — Subscribe endpoints are rate-limited per address and per IP.** 3/hour per email address, 10/hour per
IP for email, 5/hour per IP for webhooks, in database-backed fixed windows.
*Enforced:* `src/core/rate-limit.ts`, `app/actions.ts`; *tested:* `test/rate-limit.test.ts`.
*Known weakness, stated so it is a decision and not an oversight:* fixed windows allow a 2× burst across a
boundary, and on the `vm` shape a caller reaching the app directly can rotate `X-Forwarded-For` and evade the
per-IP limit — the per-address limit is the backstop there (`src/web/client-ip.ts` documents this).

**P35 — The tick endpoint is authenticated with a constant-time secret comparison.**
*Enforced:* `src/core/tick-auth.ts` (`timingSafeEqual`, length pre-check); *tested:* `test/tick-auth.test.ts`.

**P36 — A single failing channel does not block the others**, and repeated failure raises a deduped health
alert rather than silence.
*Enforced:* `src/worker/fanout.ts`, `src/core/alerts.ts`; *tested:* `test/alerts.test.ts`.

### 5.7 Secrets, transport, infrastructure (A3, A8)

**P37 — No secret is ever logged or returned in an error.** Applies to `SESSION_SECRET`, Auth0 client secret,
`whsec_…`, ESP keys, Signal and tick secrets.
*Reviewer task:* grep every `console.*` and error path for interpolated config.

**P38 — The app talks to Postgres over TLS against pinned root certificates, and fails loudly if they are
unusable.** *Enforced:* `src/db/connect.ts`; *tested:* `test/db-connect.test.ts`, `test/db-tls.integration.test.ts`.

**P39 — The app's DB role is least-privilege** (`migrations/014_app_role.sql`) — no DDL, no ability to drop
the audit log.

**P40 — Browser hardening headers are set on every response**: CSP, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy`, HSTS, `Permissions-Policy`.
*Enforced:* `next.config.mjs`.
*Known gap, deliberately:* the CSP has no `script-src` and carries `'unsafe-inline'`, so it currently
constrains framing, plugins, base URI and form targets — **not script execution**. It is not an XSS mitigation
today. A nonce strategy is the follow-up.

**P41 — The VM exposes only what it must.** Postgres, the Signal sidecar and Caddy only; SSH ACL'd;
fail2ban filter anchored on the log prefix so a username cannot forge a banned address, covering IPv6.
*Enforced:* `infra/`; documented in `infra/README.md` (which also states what has and has not been verified).

**P42 — Test tooling cannot touch a deployed database.** `npm test` truncates every table in `DATABASE_URL`;
the production guard and the documented warning are the controls.
*Reviewer note:* consider making this structural (refuse to truncate a database whose URL is not localhost),
not documentary. A destructive default protected by a README line is one CI misconfiguration from an outage.

---

## 6. Open items for the deeper review

1. **`pending_token` (preference-change link) has no expiry and no `issued_at` column** — `migrations/006`
   adds only `pending_filters` and `pending_token`, and `confirmFilterChange` matches on the token alone.
   `verify_token` got a 72-hour TTL in `migrations/016`; this sibling token did not. It is single-use (nulled
   on use) and only changes a verified subscriber's own filters, so the impact is small — but the asymmetry
   looks unintended. **Should P19 cover it?**
   → **Confirmed, and fixed.** `migrations/019` adds `pending_token_issued_at`; the lookup enforces the same
   72-hour window as its sibling, and both columns are cleared on use. P19 now covers both tokens.
2. **P29** — link-scheme validation in `validate.ts`. Verify or add.
   → **Already held.** `src/core/validate.ts` allowlists `http` and `https` in a Zod refinement, reached by
   both write paths. `actions_required` carries no URL field. No change needed.
3. **P12** — `publish_confirmed_by = 'scheduler'` overwrite: check nothing user-facing attributes a scheduled
   critical announcement to a machine actor.
   → **Confirmed, and fixed.** The enforcement was always correct: no machine could approve anything. But the
   worker overwrote `publish_confirmed_by` with the literal `'scheduler'`, so the admin review page read
   "Published … by scheduler" on exactly the announcements four-eyes exists to protect, and the two humans
   survived only in an `audit_log.detail` field nothing in the app reads. The column now keeps the approving
   publisher; the audit actor stays `'scheduler'`, because a machine did perform the send; and the review page
   names both publishers. Not retroactive: announcements published before that change keep `scheduler`.
4. **P32** — confirm no publisher email addresses reach public feeds/archive.
   → **Held.** Every reference to the four actor fields resolves to `app/admin/*` or the mutation layer. The
   feeds emit no author element, and the webhook payload uses an explicit field allowlist rather than a row
   spread. No change needed.
5. **Webhook consumer guidance** (`/docs/webhooks`): does it tell consumers to compare signatures in constant
   time and enforce a timestamp window? A correct signer with a naive verifier is still forgeable.
   → **Confirmed gap, and fixed.** The page modelled `signature !== expected` and never mentioned the signed
   `x-announce-timestamp` header, so a consumer following it exactly had a timing side channel and accepted a
   replay indefinitely. The sample now uses a length check followed by `timingSafeEqual`, and enforces a
   timestamp window. The page also states that the tool re-signs every retry, so a five-minute window does not
   reject the tool's own backoff.
6. **Slow-body / connection-holding behaviour** of the 10 s webhook timeout (P26).
   → **Held.** `AbortSignal.timeout` stays attached to the response body under Node 22 and tears the socket
   down even when the body is never read, verified by direct probe. The adapter reads only `res.ok`.
7. **Secret-in-log sweep** (P37) — mechanical, not yet done.
   → **Done, clean.** No secret reaches any `console.*` call or any thrown Error on a reachable path. The
   startup line that logs the database root certificate carries only public CA material, and the Ansible role
   deliberately never templates the VM's `.env`.

**Still open, and worth a reviewer's time:** the Content-Security-Policy. It carries no `script-src` and
includes `'unsafe-inline'`, so it constrains framing, plugins, base URI and form targets, and **is not an XSS
control today**. That is a deliberate scoping choice — Next injects inline scripts, so a nonce strategy is its
own piece of work — but it is unscheduled, and the property should not be read as stronger than it is. The
system renders publisher-authored Markdown into a public archive, so whether that is an acceptable posture is
a judgement worth taking from outside this repo.

**Also never tested end to end:** the forged-header refusal on the live Netlify deployment. `README.md` has
flagged it since before launch — sending `/admin` a request with the internal identity header hand-set, and
confirming it is refused, needs a live Auth0 tenant and has only ever been exercised in unit tests. It is a
short check for anyone with access, and it is the single most valuable thing an outside reviewer could run.

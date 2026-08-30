# aztec-announce

Release-only announcement pipeline (author once → fan out).

**Concept doc:** [announcement-tool-concept.md](../announcement-tool-concept.md) — design rationale, feature scope, architecture.  
**Follow-on plans:** Plan 2 adds channel adapters (Discord/Telegram/Email/Signal) + health alerting; Plan 3 adds public web (subscribe page, archive, feeds); Plan 4 adds admin UI; Plan 5 covers deployment and Tailscale integration.

**Two deployment shapes exist.** `main` deploys to a VM behind Tailscale (Plan 5) and remains the working, supported deployment. A separate branch, `feat/netlify-deployment` (Plan 5b), adds a serverless Netlify shape as an alternative. **That branch is not merged, and no decision has been made to move off the VM.** This README documents both, marked clearly below wherever they differ; anything not marked applies to both. `DEPLOY_TARGET` (`vm` or `netlify`) tells the app which shape it is running under — see "Startup safety checks".

**A third, split shape is being built on `feat/split-infrastructure`** (also not merged): the app and worker run on Netlify, and a separate Hetzner VM runs only Postgres, the Signal sidecar, and Caddy. The deploy procedure, security posture, and what has and has not been verified for that VM are documented in [`infra/README.md`](infra/README.md), not here — this README's Admin section covers the application, not that infrastructure.

## Development Setup

**Prerequisites:** Docker, Node 22+, npm.

```bash
# Start the dev Postgres database (runs on :5499)
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
npm install

# Run migrations. Do this before starting the app or the worker: draft
# creation writes columns added by recent migrations, and an app started
# against an un-migrated database fails on every draft.
npm run migrate

# Run tests (single-fork Vitest against real Postgres)
npm test

# Type checking
npm run typecheck

# Run the fan-out worker (15s interval loop)
npm run worker
```

## Module Map

| Module | Purpose |
|--------|---------|
| `src/core/types.ts` | Enum and type definitions (Announcement, Subscription, DeliveryTarget, etc.) |
| `src/core/ids.ts` | ID generation (ULIDs for announcements/subscriptions, secrets, slugs) |
| `src/core/validate.ts` | Zod schema + announcement validation (warnings only) |
| `src/core/subscriptions.ts` | Subscription CRUD (create, verify, match against filters) |
| `src/core/announcements.ts` | Announcement lifecycle (draft → requestPublish → confirmPublish) |
| `src/core/outbox.ts` | Transactional outbox pattern (enqueueDeliveries, broadcastTargets) |
| `src/core/health.ts` | Channel health evaluation (exhausted/no_delivery detection) |
| `src/adapters/types.ts` | ChannelAdapter interface |
| `src/adapters/webhook.ts` | Webhook delivery with HMAC-SHA256 signing and SSRF guard |
| `src/adapters/discord.ts` | Discord delivery via incoming webhook (`channel_settings`-configured) |
| `src/adapters/telegram.ts` | Telegram delivery via Bot API `sendMessage` (plain text) |
| `src/adapters/email.ts` | Email delivery via `EmailSender`, one-click unsubscribe headers |
| `src/adapters/signal.ts` | Signal delivery via a `signal-cli-rest-api` sidecar |
| `src/adapters/esp.ts` | Email Sending Provider abstraction (Resend/Brevo/console) + `senderFromEnv` |
| `src/core/alerts.ts` | Deduped channel-health email alerts (`dispatchHealthAlerts`) |
| `src/worker/fanout.ts` | Main fan-out loop (drain outbox, retry logic, ledger updates) |
| `src/worker/main.ts` | Worker entry point (15s interval, all adapters, health alerts) |
| `test/helpers.ts` | testSql() + resetDb() for integration tests |

## Webhook Payload Format

Webhook subscribers receive a POST with this JSON body:

```json
{
  "event_id": "<announcement_id>.<revision>.<kind>",
  "kind": "publish",
  "announcement": {
    "id": "ann_01J9XK...",
    "revision": 1,
    "slug": "2026-08-upgrade-v5-1-0",
    "type": "upgrade",
    "networks": ["mainnet"],
    "audiences": ["operators"],
    "severity": "critical",
    "title": "Upgrade to v5.1.0 required by 2026-08-20 14:00 UTC",
    "body_md": "...markdown...",
    "actions_required": [
      {
        "action": "Upgrade node to v5.1.0",
        "deadline": "2026-08-20T14:00:00Z",
        "applies_to": ["sequencer"]
      }
    ],
    "links": [
      { "label": "GitHub release", "url": "https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0" }
    ],
    "published_at": "2026-08-06T10:00:00Z"
  }
}
```

### Request Headers

| Header | Value |
|--------|-------|
| `content-type` | `application/json` |
| `x-announce-event-id` | `<announcement_id>.<revision>.<kind>` |
| `x-announce-timestamp` | Unix seconds (integer) |
| `x-announce-signature` | `v1=<hex>` where hex is HMAC-SHA256 of `"${timestamp}.${body}"` |

### Signature Verification

Subscribers must verify the signature using their secret:

```typescript
import { createHmac } from 'node:crypto';

const secret = '...subscriber secret...';
const timestamp = req.headers['x-announce-timestamp'];
const signature = req.headers['x-announce-signature'];
const body = req.body; // raw request body as string

const expected = 'v1=' + createHmac('sha256', secret)
  .update(`${timestamp}.${body}`)
  .digest('hex');

if (signature !== expected) {
  throw new Error('Invalid signature');
}
```

### Retry Policy

- **Max attempts:** 5 (then marked `exhausted`)
- **Backoff:** [2, 5, 10, 20, 30] minutes
- **Idempotency:** consumers must dedupe on `event_id`
- **Timeout:** 10 seconds per request

## Channels

The worker knows about five channels — `webhook`, `discord`, `telegram`, `email`, `signal` — but registers an adapter only for the ones `ENABLED_CHANNELS` names (see "Which channels this deployment runs" under Configuration). Unset, that variable means all five, so an operator who has not set it keeps today's behaviour. Delivery targets are matched to subscriptions/settings by the `target` key on each `delivery_ledger` row; for webhook and email, `target` is a subscription id (`subscriptions` table). For discord, telegram, and signal, `target` is a `channel_settings.key` — there is no self-serve subscribe flow for these three, so destinations are configured directly in Postgres (see the worked example below). Admin-editable channel settings are Plan 4 scope.

**On the Netlify shape (`feat/netlify-deployment`, not merged), Signal must not be enabled.** Netlify runs functions, not persistent containers, and the Signal channel needs an always-running `signal-cli-rest-api` sidecar (see the Signal section below) — there is nowhere on Netlify to run it. The startup guard enforces this: on `DEPLOY_TARGET=netlify`, it refuses to start if `ENABLED_CHANNELS` is unset (which would default to all five, including Signal) or if it names `signal`. The Signal adapter code is untouched and keeps working on the VM shape; it would need a separate host if Signal support is wanted alongside a Netlify deployment.

### Discord

Posts to a Discord incoming webhook URL. Configured via a `channel_settings` row with `channel = 'discord'`:

```sql
insert into channel_settings (key, channel, config) values
  ('discord:mainnet-updates', 'discord', '{
     "networks": ["mainnet"], "types": ["upgrade","info"],
     "webhook_url": "https://discord.com/api/webhooks/...",
     "roles": [
       { "name": "Mainnet Sequencer", "id": "1234567890123456789" },
       { "name": "Genesis Sequencer", "id": "2345678901234567890" }
     ],
     "prefix": "📣",
     "username": "Aztec Announcements"
   }');
```

- `webhook_url` (required) — the Discord incoming webhook URL for the target channel.
- `roles` (optional) — named roles this destination can mention, as `{ name, id }` pairs. Set with `npm run setup:channel`, not by hand — see "Where mentions belong" below.
- `prefix` (optional) — an emoji preamble prepended to the message body, on its own line. It is text only: any mention typed into it (a pasted `<@&ROLE_ID>` / `<@ID>`, or a literal `@everyone` / `@here`) is stripped before sending, never posted and never permitted. Use the role selection below for mentions. Prefix text is limited to 512 characters; `npm run setup:channel` refuses a longer prefix and prompts again, because the mention-stripping pass is quadratic on nested input and accidental large pastes would otherwise impact every preview and delivery.
- `username` (optional) — overrides the webhook's default display name.
- `networks` / `types` — used by the fan-out matcher to decide whether an announcement routes to this destination; not read by the adapter itself.
- **Env vars:** none — the webhook URL carries its own auth.
- **Failure mode:** any non-2xx response from Discord throws and is retried under the standard backoff; a missing `webhook_url` fails the same way and is retried through all five backoff steps, failing identically each time before showing up as `exhausted` in channel health.

### Telegram

Posts to the Telegram Bot API `sendMessage` endpoint, as plain text (not MarkdownV2 — see the code comment in `src/adapters/telegram.ts` for why: MarkdownV2 requires escaping ~18 characters and one missed escape rejects the whole message).

```sql
insert into channel_settings (key, channel, config) values
  ('telegram:testnet-updates', 'telegram', '{
     "networks": ["testnet"], "types": ["upgrade","incident","info"],
     "chat_id": "-1001234567890"
   }');
```

- `chat_id` (required) — the numeric Telegram chat/channel id (channels are typically negative, prefixed `-100`).
- **Env vars:** `TELEGRAM_BOT_TOKEN` (required) — the bot token from BotFather; the bot must already be an admin/poster in the target chat.
- **Failure mode:** HTTP error or `{ ok: false }` in the response body both throw and retry; a missing `TELEGRAM_BOT_TOKEN` fails every attempt identically.

### Email

Sends via the configured `EmailSender` (see Configuration below). Targets are subscription rows (`subscriptions` table, `channel = 'email'`), not `channel_settings` — there is no per-destination JSON config for email.

- Requires the subscription to be `verified`; unverified subscriptions are skipped with an error (no delivery, no retry benefit — this will keep failing until the subscriber verifies).
- Injects a one-click unsubscribe link (`{{UNSUBSCRIBE}}` placeholder in the rendered body, replaced with `${PUBLIC_BASE_URL}/u/<token>`) and sets `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
- **Env vars:** `ESP_PROVIDER`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, plus provider-specific keys (`RESEND_API_KEY` or `BREVO_API_KEY`) — see Configuration.
- **Failure mode:** ESP HTTP errors throw and retry under standard backoff; a missing subscription or an unverified one throws immediately.

### Signal

Sends via a `signal-cli-rest-api` sidecar (`bbernhard/signal-cli-rest-api`, see `docker-compose.dev.yml`) holding a registered Signal number — there is no official Signal bot API. This is the least reliable channel by design; errors carry the sidecar's response body so channel-health alerting surfaces registration/protocol breakage instead of silent message loss.

```sql
insert into channel_settings (key, channel, config) values
  ('signal:mainnet-ops', 'signal', '{
     "networks": ["mainnet"], "types": ["upgrade","incident"],
     "group_id": "group.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX="
   }');
```

- `group_id` (required) — the Signal group id (base64, as returned by `signal-cli listGroups`).
- **Env vars:** `SIGNAL_ACCOUNT` (required) — the registered sender number, e.g. `+15551234567`. `SIGNAL_API_BASE` (default `http://127.0.0.1:8080`) — base URL of the sidecar. `SIGNAL_API_SECRET` (unset by default; required on the split deployment) — shared secret sent as `x-announce-signal-secret` to the Caddy proxy in front of the sidecar; unset sends no header, which is what the same-Docker-network VM deployment expects.
- **Failure mode:** any non-2xx response from the sidecar throws (with body text appended) and retries under standard backoff; a missing `SIGNAL_ACCOUNT` fails every attempt identically.

## Configuration

Copy `.env.example` to `.env` and fill in what each channel needs. All values below are defaults or placeholders — no live secrets.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEPLOY_TARGET` | *(unset)* | `vm` or `netlify`. Required in production; an unset or unrecognized value fails startup closed. Selects which identity source and which startup checks apply — see "Startup safety checks". |
| `DATABASE_URL` | `postgres://announce:announce@127.0.0.1:5499/announce` | Postgres connection string used by the worker (or, on the Netlify shape, the `tick-background` function) and migrations. On Netlify this must point at a reachable managed Postgres instance — there is no bundled database. Must NOT include `sslmode` or `sslrootcert` in its query string — those bypass `DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` below and startup refuses to build a connection if either is present. |
| `DATABASE_SSL_MODE` | *(unset)* | `verify-full` to require a verified TLS connection to Postgres — needed whenever the database is not reachable only over a private network (e.g. the Hetzner-VM split deployment, where the database port is exposed to the public internet). Unset means plaintext, for a private link such as loopback, Tailscale, or the docker-compose network. `require` is refused (encrypts but does not verify the server, so it does not stop an active attacker); any other value fails startup. |
| `DATABASE_SSL_ROOT_CERT` | *(unset)* | Path to the CA bundle used to verify the Postgres server certificate. Required whenever `DATABASE_SSL_MODE=verify-full` — without an explicit CA, verification would silently fall back to the system trust store, which may not contain the issuer, so startup refuses rather than connecting with an unverified guarantee. |
| `PUBLIC_BASE_URL` | `https://announce.aztec.network` | Base URL used to build the email unsubscribe link (`/u/<token>`). |
| `TELEGRAM_BOT_TOKEN` | *(unset)* | Bot token from BotFather; required for any Telegram delivery. |
| `SIGNAL_API_BASE` | `http://127.0.0.1:8080` | Base URL of the `signal-cli-rest-api` sidecar. |
| `SIGNAL_ACCOUNT` | *(unset)* | Registered Signal sender number; required for any Signal delivery. |
| `SIGNAL_API_SECRET` | *(unset)* | Shared secret sent as the `x-announce-signal-secret` header to the `signal-cli-rest-api` sidecar. Unset sends no header at all — correct for the same-Docker-network VM deployment. Required on the split deployment, where a Caddy proxy in front of the publicly-reachable sidecar checks this header and rejects requests without it; this value must match the proxy's configured secret. |
| `ESP_PROVIDER` | `console` | Email Sending Provider: `console` (logs to stdout, dev default) \| `resend` (dev/staging) \| `brevo` (prod). |
| `EMAIL_FROM` | *(unset)* | From address; required by both `resend` and `brevo` providers. |
| `EMAIL_FROM_NAME` | `Aztec Announcements` | From display name; used by `brevo` only. |
| `RESEND_API_KEY` | *(unset)* | Required when `ESP_PROVIDER=resend`. |
| `BREVO_API_KEY` | *(unset)* | Required when `ESP_PROVIDER=brevo`. |
| `ALERT_EMAIL_TO` | *(unset)* | Destination address for channel-health alert emails. Not in `.env.example` (opt-in). Unset disables alerting entirely — see Alerting below. |
| `ENABLED_CHANNELS` | *(unset)* | Comma-separated channels this deployment fans out to. Unset means all five. See "Which channels this deployment runs" under Admin. |

Discord, Telegram, and Signal *destinations* (webhook URLs, chat/group ids) are not environment variables — they live in `channel_settings` rows, since a deployment typically has more than one destination per channel.

**Netlify shape only** (`feat/netlify-deployment`, not merged) — these variables have no effect on the VM shape and are not read there:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTH0_DOMAIN` | *(unset)* | Provisioned by the Netlify Auth0 extension. Used to derive the token issuer (`https://<domain>/`) if `AUTH0_ISSUER` is not set directly. |
| `AUTH0_CLIENT_ID` | *(unset)* | Provisioned by the Netlify Auth0 extension. Used as the expected token audience if `AUTH0_AUDIENCE` is not set directly. |
| `AUTH0_AUDIENCE` | *(unset)* | Expected JWT audience. Takes precedence over `AUTH0_CLIENT_ID` if both are set. |
| `AUTH0_ISSUER` | *(unset)* | Expected JWT issuer. Takes precedence over the value derived from `AUTH0_DOMAIN` if both are set. |
| `AUTH0_CLIENT_SECRET` | *(unset)* | Auth0 application client secret. Required for the browser login flow — `app/admin/callback/route.ts` uses it to exchange the authorization code for tokens. Required in production on the Netlify shape; the app refuses to start without it. |
| `SESSION_SECRET` | *(unset)* | Signing key for the browser session cookie (`src/core/session.ts`). Required for the browser login flow, and required in production on the Netlify shape — the app refuses to start unless it is set and at least 32 characters. Generate one with `openssl rand -base64 32`. |
| `TICK_SECRET` | *(unset)* | Shared secret authenticating the `tick-scheduled` → `tick-background` call. That endpoint is public HTTP with nothing else in front of it, so this is the only thing stopping anyone who finds the URL from forcing repeated fan-out ticks. Must be a long random value in production; unset or empty refuses every request rather than allowing them. |

`AUTH0_DOMAIN`/`AUTH0_CLIENT_ID`/`AUTH0_AUDIENCE`/`AUTH0_ISSUER` are not secrets in the traditional sense (they are not bearer credentials on their own), but `AUTH0_CLIENT_SECRET`, `SESSION_SECRET`, and `TICK_SECRET` are — see the "never commit a secret" note in `.env.example`.

**Registering the browser login flow with Auth0:** create (or reuse) a regular web application in the Auth0 dashboard and set:

- **Allowed Callback URLs** — the full callback path: `https://<your-site>/admin/callback`.
- **Allowed Web Origins** — the bare origin only, with no path: `https://<your-site>`.

These two fields are easy to confuse and take different shapes — pasting the full callback path into Allowed Web Origins (or the bare origin into Allowed Callback URLs) produces a callback-mismatch error and blocked a real deployment attempt. Sign-in starts at `/admin/login` (redirects to Auth0, then back to `/admin/callback`, which sets the session cookie); `/admin/logout` clears it.

## Public web

A Next.js app (App Router) in `app/` serves the public subscribe page, archive, feeds, and token-based flows.

| Route | Purpose |
|-------|---------|
| `/` | Subscribe page — email form, webhook form, broadcast-channel links. |
| `/a/<slug>` | A single published announcement. |
| `/archive` | List of published announcements. |
| `/feed.json` | JSON feed of published announcements. |
| `/feed.atom` | Atom feed of published announcements. |
| `/confirm/<token>` | Email double-opt-in confirmation link. |
| `/u/<token>` | Unsubscribe — GET shows a confirm page, POST unsubscribes (also serves the RFC 8058 one-click `List-Unsubscribe-Post` request). |
| `/manage/<token>` | Update email subscription filters. |
| `/docs/webhooks` | Webhook consumer docs — payload shape, headers, signature verification, retries. |

**Run it:** `npm run web` for dev (Next dev server); `npm run web:build && npm run web:start` for a production build.

**Behavior notes:** Email subscribing is double-opt-in — a new address gets a confirmation link and delivers nothing until it's clicked, and re-submitting an already-confirmed address just updates its filters, with both cases redirecting to the same `/subscribed` page so the response never reveals which happened. Registering a webhook sends an immediate `kind: "test"` verification POST to the endpoint, signed the same way as real deliveries, and only activates the subscription on a 2xx response; the signing secret is shown exactly once, on the registration result, and is never displayed again.

## Admin

The admin UI (`/admin`) is where announcements are composed, previewed, and published. It is a set of Next.js server routes and server actions under `app/admin/`; no separate service.

### Identity

Every admin route resolves the caller's identity from request headers (`src/core/identity.ts`), checked in this order:

1. **Netlify shape only** (`feat/netlify-deployment`, not merged) — a verified Auth0 identity. `middleware.ts` reads the `Authorization: Bearer <JWT>` header on every `/admin` request, verifies the token's signature, issuer, audience, and expiry against the Auth0 tenant (`AUTH0_ISSUER`/`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`/`AUTH0_CLIENT_ID`), confirms the token carries a verified email claim, and only then sets an internal header that `resolveIdentity` reads. **`middleware.ts` strips any inbound copy of that internal header first, unconditionally, before doing anything else** — that strip, done first and without any branch above it, is the only reason the header is safe to trust; without it, anyone who could reach the app directly could set the header themselves and self-approve as any identity, defeating four-eyes on critical announcements. There is no other authenticating proxy in front of the app on Netlify.
2. **VM shape** (`main`) — identity comes from Tailscale's `Tailscale-User-Login` proxy header (plus optional `Tailscale-User-Name`). This is sound **only** because the app binds to `localhost` and `tailscale serve` is the sole route in — if the port were ever exposed directly, these headers could be forged by any caller.
3. In development only, set `ADMIN_EMAIL` and it is used as a fallback identity when neither of the above resolves anything.

If none of the three resolves an identity, the admin layout renders an access-denied page instead of the requested content — a **Sign in with Google** link to `/admin/login` on the Netlify shape (`DEPLOY_TARGET=netlify`), or the tailnet message on the VM shape.

**Manual check required before any Netlify cutover:** send `/admin` a request with the internal auth header hand-set to an arbitrary identity and confirm access is DENIED. `middleware.ts` has no automated test coverage of this path — it requires a live Auth0 tenant to exercise end to end — so this check has not been run against a real deployment.

**Known follow-up, not done in this branch:** Next 16.2.12 deprecates `middleware.ts` in favor of `proxy.ts`. Migrating is a separate task; this branch keeps `middleware.ts` as documented above.

### Startup safety checks

Both the web app and the worker (or, on the Netlify shape, the `tick-background` function) refuse to run unless all of the following hold. This is enforced code (`src/core/production-guard.ts`, wired into `instrumentation.ts` for the web app, `src/worker/main.ts` for the VM worker, and `netlify/functions/tick-background.ts` for the Netlify function), not just documentation — a misconfigured process will not run.

- `DEPLOY_TARGET` is set to `vm` or `netlify`. This decides which identity source is trusted and which of the two checks below applies. **An unset or unrecognized value fails closed** — it does not skip the checks, it refuses to start.
- `ADMIN_EMAIL` is **unset**. It is the dev-only identity fallback; set in production, it would grant admin to any request lacking a Tailscale or verified Auth0 header.
- `PUBLIC_BASE_URL` is set and starts with `https://`. Otherwise confirmation and unsubscribe links sent to real subscribers point at the wrong host.
- At least one row exists in the `publishers` table — seed one with `npm run seed:publisher -- you@example.com`.

The remaining check depends on `DEPLOY_TARGET`, since the two shapes trust different identity sources:

- **`DEPLOY_TARGET=vm`** — `HOSTNAME` must be `127.0.0.1` or `::1`. Unset or anything else, the server binds every interface, exposing the forgeable Tailscale header directly. This is unchanged from before this branch existed.
- **`DEPLOY_TARGET=netlify`** — an Auth0 issuer (`AUTH0_ISSUER` or `AUTH0_DOMAIN`) and audience (`AUTH0_AUDIENCE` or `AUTH0_CLIENT_ID`) must both be present. Without them `middleware.ts` cannot verify a bearer token, and on Netlify there is no other authenticating proxy in front of the admin routes. `SESSION_SECRET` must also be set and at least 32 characters — it signs the browser session cookie, one of the identities four-eyes trusts, and a short or missing secret makes that cookie brute-forceable. `AUTH0_CLIENT_SECRET` must also be set, or `app/admin/callback/route.ts` cannot exchange the authorization code for tokens and every sign-in attempt fails closed with no explanation on the page.

**These checks run always, regardless of `NODE_ENV`, unless `ANNOUNCE_ALLOW_INSECURE_DEV=1` is set.** They are deliberately not keyed on `NODE_ENV=production`: `next start` only *defaults* `NODE_ENV` to production rather than overriding an existing value, so `NODE_ENV=staging next start` would otherwise leave the app in a non-production `NODE_ENV` and skip every check while still serving admin traffic. `.env.example` sets `ANNOUNCE_ALLOW_INSECURE_DEV=1` for local development; it must never be set on a deployed instance, since setting it removes the only thing enforcing that the forgeable identity header — Tailscale's or Auth0's internal one — is safe to trust.

A start that fails these checks exits non-zero after printing the problems for the worker, and the Netlify `tick-background` function logs the problems and returns without doing any work. For the web app, the check runs inside Next's `register()` startup hook — throwing there does **not** abort the process; Next logs the error and the server keeps running, returning 500 on every request. So if the web app is ever seen listening but every request 500s, check these first — a health check must send a real request, not just confirm the port is open, or it will report a misconfigured instance as healthy.

The two public server actions (email subscribe, webhook registration) are rate-limited, but the mechanism differs by shape:

- **VM shape** — in-memory, per process: 5 email-subscribe attempts and 10 webhook registrations per 10 minutes. This limit resets on process restart and is not shared across multiple instances. It lives in `src/core/rate-limit.ts` **on `main` only** — that file does not exist on this branch, which deleted it (see below).
- **Netlify shape** (`feat/netlify-deployment`, not merged) — the in-memory limiter was removed, since a serverless function has no persistent process to hold its state. Rate limiting moved to `netlify.toml`, which attaches a rule to the `/` path (20 requests per 60 seconds, aggregated by domain+IP). **This is a narrower guarantee than the VM shape's, and `netlify.toml` documents the gap in a comment — read it before assuming both public actions are protected separately.** Netlify's rate-limit rules match on request path only, with no method or body matching, and both public server actions (`subscribeEmail`, `subscribeWebhook`) are Next.js Server Actions that POST to the same path (`/`) — the framework dispatches between them server-side using an internal header Netlify's redirect rules cannot see. So one shared rule is the finest distinction actually available; it cannot rate-limit `subscribeEmail` and `subscribeWebhook` independently, and it also shares its budget with ordinary page loads to `/`. Neither `netlify.toml` nor this doc claims otherwise.

### Which channels this deployment runs

`ENABLED_CHANNELS` (comma-separated, e.g. `webhook,discord,telegram,email`) controls which of the five channels — `webhook`, `discord`, `telegram`, `email`, `signal` — this deployment fans out to. It is read by the worker (or, on the Netlify shape, the `tick-background` function), the preview, the admin compose/review UI, and `scripts/setup-channel.ts`, so one value governs all of them.

- **Unset or blank means all five.** This preserves the behaviour every deployment had before this variable existed.
- **An unknown name refuses to start**, rather than being silently ignored — a typo (`ENABLED_CHANNELS=discord,emial`) would otherwise disable a channel the operator believes is on, and the failure would only surface later as "the announcement reached nobody by email."
- **On `DEPLOY_TARGET=netlify`, the startup guard (`src/core/production-guard.ts`) refuses to start** if `ENABLED_CHANNELS` is unset (which would default to all five, including Signal) or if it names `signal` — Netlify has no `signal-cli` sidecar to reach from a serverless function. On `DEPLOY_TARGET=vm`, unset still means all five; Signal is allowed there.
- **Disabling a channel does not hide past deliveries.** The `delivery_ledger` table and the admin delivery views are deliberately unfiltered by this variable, so an announcement that already published to a channel still shows that delivery record after the channel is disabled.
- **`npm run setup:channel` refuses to configure a destination on a disabled channel**, so a `channel_settings` row can't be created for a channel that will never deliver to it.

### Publishers and the bootstrap rule

`app/admin/layout.tsx` checks the resolved identity against the `publishers` table (`isPublisher` in `src/core/identity.ts`) before rendering any admin page, so a non-publisher tailnet identity cannot read drafts, requester emails, fan-out targets, or templates either. Each mutating server action in `app/admin/actions.ts` also runs its own `isPublisher` check independently — the layout is not the only enforcement point for writes.

- **Bootstrap rule:** if the `publishers` table is empty, every identity is treated as a publisher. This exists so the first deployment isn't locked out before anyone has been added.
- While the table is empty, the admin shell shows a standing warning: "No publishers configured — anyone reaching this page can publish. Add publishers before launch."
- **Publishers must be added to the table before launch.** Once at least one row exists, only listed emails may compose, preview, or publish.
- If the publisher lookup itself fails (e.g. database unreachable), the layout fails closed and shows an "Admin is unavailable" page rather than falling through to open access.

### Compose, preview, publish

1. **Compose** (`/admin`) — a form with type/network/audience/severity selectors, a Markdown body with a formatting toolbar, and repeatable "actions required" and "links" fields. Submitting creates a draft (`createDraft`) and redirects to its review page.
2. **Review** (`/admin/review/<id>`) — shows the rendered body, a summary of which destinations the announcement will fan out to, and the publish control. The review page renders the exact payload each channel will receive in the same "Rendered" and "Raw" views as the compose page (webhook JSON, Discord/Telegram/Signal message text including the selected Discord role mentions, email rendering). The payload is built from the stored announcement, so the slug in every canonical link and the `event_id` in the webhook JSON are the ones that will actually be sent. For an announcement that has not published yet, `published_at` shows as `null` because the publishing transaction sets it.

### Preview modes

Each channel tab has two modes.

**Rendered** approximates what a reader sees on that platform: headings appear as headings, bold as bold, inline code as a monospace chip, and Discord role mentions as pills. Use this mode to check the announcement reads well.

**Raw payload** shows the exact string sent to that channel. Use this mode to verify what actually goes on the wire.

For Discord, the raw payload is the authoritative view. It shows the mention line built from the roles selected on the compose form, followed by the emoji preamble, exactly as it will be posted. Always read the raw Discord payload before publishing and confirm the mentions are the ones you intend.

Markdown headings render differently per channel, because the platforms differ:

| Channel | `## What changes` appears as |
|---|---|
| Discord | a native Discord heading |
| Telegram | a bold line (Telegram HTML has no heading tag) |
| Signal | `WHAT CHANGES` (plain text only) |
| Email | a real heading in the HTML part, `WHAT CHANGES` in the text part |

### Where mentions belong

The announcement body is shared by every channel. Only Discord turns `@everyone`,
`@here` or a role mention into a notification — on Telegram, Signal, email and
webhook the same text arrives as literal characters a reader cannot act on. Do
not put mentions in the announcement body. The compose form warns if it finds
one there, and the warning still applies: put mentions in the role selection
described below, not the body.

**Do not rely on typing a mention into the Discord prefix.** The prefix is an
emoji preamble only. Any mention pasted or typed into it — a role mention, a
user mention, or a literal `@everyone` / `@here` — is stripped before the
message is sent and never notifies anyone.

Configure named roles per Discord destination with `npm run setup:channel`.
Each role is a name and a numeric Discord role id, stored in that
destination's `channel_settings` row. To get an id: enable Developer Mode in
Discord, right-click the role, and choose "Copy Role ID" — the tool checks
that what you paste is all digits.

The name is a label for this tool's own interface only; Discord resolves the
mention from the id. Renaming the role in Discord later leaves the label
here stale until someone re-runs `setup:channel` to update it — cosmetic,
not functional, since the id still resolves correctly either way.

`@everyone` and `@here` need no id. They are offered as built-in choices
alongside the configured named roles, since Discord resolves them from
literal text rather than a role id.

The compose form's role checkboxes decide, per announcement, which roles a
Discord post mentions. Critical announcements select every configured role
(including the built-ins) by default; other severities select none.

**Caution before selecting `@everyone` or `@here`:** Discord's everyone
permission has no id-list form, so selecting either one also re-enables any
literal `@everyone` or `@here` that ends up in the message body, even though
the body warning above told you not to put one there. Selecting only named
roles does not have this effect — a stray literal mention in the body still
cannot ping. The review page shows a banner above the preview tabs naming every
role the post will notify, so a confirming publisher sees the mention set
without opening the Discord tab. Before publishing, read the raw Discord
preview and confirm the mentions shown are the ones you intend.

With that in mind, the author can check or uncheck any of the roles before
requesting or publishing. Selecting none sends the post with no mention line
at all. Every other channel is unaffected regardless of what is selected here.

A destination configured before named roles existed — one with only a
`prefix` and no `roles` — keeps posting its prefix unchanged; it has no
roles to select and the prefix carries no mention, as above.

### Composing

**Public URL.** The slug is generated from the month, type and title, and is editable before the first save. It becomes the permanent public path (`/a/<slug>`) and is unique across announcements, so changing it after publication breaks links that are already distributed. The generation step skips the type word if the title already starts with it (for example, a title "Upgrade to v5.3.0" with type "upgrade" produces no repeated word). The slug is capped at 5 title words (after the type word is removed, if applicable).

**Times are UTC.** Deadline fields are entered and displayed in UTC, matching how announcements state deadlines to operators. What you type is what operators receive, regardless of where you are. Out-of-range values — day 32, month 13, hour 25 — are rejected rather than silently rolling over into the next month.

**Applies to.** Select from the common operator roles (`sequencer`, `prover`, `full-node`), or type a role the tags do not cover — the vocabulary is curated, not closed.

**Awaiting confirmation.** Critical announcements need a second publisher. When a critical announcement's publication is requested, it appears at the top of the admin page for every publisher, so the second person does not need a link sent to them. The requester cannot confirm their own request. Non-critical announcements publish immediately on request.

3. **Publish:**
   - **Non-critical** severity publishes in one step — "Publish now" calls `requestPublish`, which publishes immediately and enqueues deliveries.
   - **Critical** severity requires two different publishers (four-eyes): "Request publication" moves the draft to `publish_requested`. The requester sees a waiting state; any *other* publisher sees "Confirm and publish". If the same identity that requested tries to confirm, `confirmPublish` throws `FourEyesError` and the review page shows it as an inline error, not a crash.

### Withdrawing and rejecting

A critical announcement waiting for confirmation can go back to draft two ways:
`withdrawPublish` and `rejectPublish` (`src/core/announcements.ts`). Both are
available from the review page, and a withdraw control also appears on the
pending queue for the requester's own requests.

**Withdraw** — only the publisher who requested it can take the request back.
Use this after spotting a mistake before a second person confirms. The
announcement returns to `draft`, the requester field is cleared, and any
earlier rejection recorded on it is cleared too, so a withdrawn-and-reopened
draft carries no stale rejection banner. A fresh request still needs a second
person to confirm.

**Reject** — only a publisher *other than* the requester can reject, and a
reason is required; an empty or whitespace-only reason is refused. The
announcement returns to `draft` with `publishRejectedBy` and
`publishRejectedReason` recorded, and the review page shows the reason on the
draft so the author sees the objection when they reopen it. After a rejection,
the announcement is an ordinary draft: any publisher, including the one who
rejected it, may edit it and request publication again. Four-eyes is not
weakened — whoever requests becomes the requester, and a different publisher
must still confirm before it publishes.

Both actions run inside the same database transaction as the audit log entry
they write (`publish_withdrawn` or `publish_rejected`, with actor and
timestamp; the rejection reason is recorded too). Neither deletes anything —
an announcement row is never removed.

### Scheduling

Instead of publishing immediately, a publisher can schedule an announcement
for a future time. The review page's schedule control (`schedulePublish` in
`src/core/announcements.ts`) takes a date and time entered and shown in
**UTC**, matching every other time field in this tool.

**Four-eyes timing for scheduled critical announcements is different from
immediate publishing.** For a critical announcement, the second publisher's
approval must happen **before** the announcement becomes `scheduled`, not at
send time. Scheduling a critical announcement moves it to
`publish_requested`, the same waiting state as an immediate request. A
different publisher must then confirm the schedule (`confirmSchedule`) —
only after that confirmation does the announcement become `scheduled`. As
with immediate publishing, the requester cannot confirm their own request.
Non-critical announcements move straight to `scheduled` on request, since
they need only one publisher.

**VM shape** — a background worker (`npm run worker`, `src/worker/main.ts`) checks for due announcements every 15 seconds, so a scheduled announcement sends within about a minute of its scheduled time. Each check publishes at most 20 due announcements; if more than 20 are due at once, the rest send on a later check.

**Netlify shape** (`feat/netlify-deployment`, not merged) — there is no always-on process, so the tick is split into two functions: `netlify/functions/tick-scheduled.ts` runs on a schedule declared inline in that file (every minute) and does nothing but call `netlify/functions/tick-background.ts`, which does the actual tick work and is allowed up to 15 minutes to run. Both call the same `runTick` (`src/worker/tick.ts`) and `buildAdapters` (`src/worker/adapters.ts`) that the VM worker uses, extracted so there is exactly one implementation of the tick logic shared by both shapes.

`tick-background` is a public HTTP endpoint — Netlify puts nothing in front of it — authenticated only by a shared `TICK_SECRET` header. It refuses with a 404 (not 401/403, so a prober cannot tell the endpoint exists) whenever the secret is missing, empty, or wrong, comparing with a timing-safe check (`src/core/tick-auth.ts`). **An unset `TICK_SECRET` refuses every request rather than allowing them** — the same fail-closed pattern as the other checks in this section.

**Neither the two functions nor `netlify.toml`'s syntax has been executed against a real Netlify deployment** — there is no Netlify CLI in this environment, so this is unverified beyond passing tests and a manual code read. Confirm functions actually run and tick on a real site before relying on this shape.

In both shapes, **the tick never approves anything** — `publishDueScheduled` only moves an announcement that two people already approved from `scheduled` to `published`, calling the same `performPublish` function an immediate publish uses, so a scheduled send is provably identical to one a publisher sends by hand.

**Cancelling.** Any publisher may cancel a scheduled announcement before it
sends, not only the one who scheduled it (`cancelSchedule`). It returns to
`draft`, clearing the schedule and both approvals, so re-scheduling needs a
fresh request and a fresh second confirmation. Withdrawing or rejecting a
critical announcement that is still awaiting its schedule confirmation also
clears the schedule, for the same reason.

**`published_at` records when the announcement actually sent**, not the time
it was scheduled for — the publishing transaction sets it at send time,
whether that send was immediate or carried out by the worker.

### Drafts, editing and discarding

The admin page (`/admin`) lists every draft, including one returned by a
withdrawal or a rejection (`listDrafts` in `src/core/queries.ts`). Without
this list a rejected draft would be unreachable: not on the archive
(published only), not on the pending queue (awaiting confirmation only). A
rejected draft's row shows who rejected it and why, taken from the same
`publishRejectedBy` / `publishRejectedReason` fields described above.

Each row offers **Edit** and **Discard**.

**Edit** (`/admin?from=edit:<id>`) continues the same announcement rather
than starting a new one. Saving creates a new revision under the same id;
the slug and the public URL (`/a/<slug>`) do not change. The slug field is
read-only in edit mode for this reason.

**Only a draft can be edited.** `reviseDraft` (`src/core/announcements.ts`)
checks the current status and refuses anything else. A published
announcement has no edit control on its review page — publish a correction
as a new announcement instead.

**Caution: discarding cannot be undone through the UI.** Before discarding,
confirm the draft is not needed — check whether editing and resubmitting is
the better option. Discarding removes the draft from every list; there is no
UI path back from a discarded draft to a draft.

**Discard** is a two-step control: the first click arms it, the second
confirms. `discardDraft` sets the announcement's status to `discarded` and
writes an audit log entry. The row and its audit trail are not deleted —
only its status changes — but a discarded announcement appears in no list.
Its review page still opens by direct link. That page shows the announcement
body and marks it as discarded, with no publish or edit controls, no
destination list, and no preview — a discarded announcement will never send, so showing where
it would have gone or what it would have looked like would be misleading. Discarding is terminal: a discarded draft
cannot be edited, requested for publication, or discarded again. It also
keeps its slug, so that public URL is never reused.

### Templates and starting points

The compose page (`/admin?from=template:<id>` or `?from=announcement:<id>`) can prefill the form three ways:

- **Blank** — the default, empty form.
- **Saved template** — pick from the "Saved templates" dropdown, sourced from the `templates` table. Any draft can be saved as a template from the compose form ("Save as template").
- **Past announcement** — start from a previously published announcement (`listPublished`), reusing its text, type, networks, audiences, and severity.

In both prefill cases, **all dates are cleared** — every action's `deadline` — so a reused announcement can never carry a stale, already-past deadline into a new draft. The form shows a note when prefilled: "Deadlines are cleared — set new ones below."

### Running admin locally

```bash
ADMIN_EMAIL=you@example.com npm run web
```

Then open `/admin`. With an empty `publishers` table, any `ADMIN_EMAIL` value is accepted (bootstrap rule above). To exercise the four-eyes flow locally, request publication with one `ADMIN_EMAIL`, then restart (or run a second dev server) with a different `ADMIN_EMAIL` to confirm.

## Alerting

The worker calls `dispatchHealthAlerts` on every 15s tick (`src/core/alerts.ts`), which wraps `evaluateChannelHealth` (`src/core/health.ts`) with deduped, one-time-only email notification:

- `evaluateChannelHealth` scans the delivery ledger for two issue kinds: `exhausted` (a target used up all 5 retry attempts) and `no_delivery` (a published announcement has no successful delivery yet on a channel that hasn't fully exhausted).
- Each issue is keyed by `<kind>:<channel>:<announcementId>` and recorded in the `alert_state` table. A given key is emailed **exactly once, ever** — repeated ticks that see the same unresolved issue do not re-send. Rows are claimed with `for update skip locked` inside the same transaction as the send, so concurrent worker instances never double-alert.
- All new issues on a tick are batched into a single email (one email per tick with new issues, not one per issue) sent to `ALERT_EMAIL_TO` via the configured `EmailSender`.
- **If `ALERT_EMAIL_TO` is unset, alerting is disabled**: `dispatchHealthAlerts` logs a warning and returns immediately without touching `alert_state`, so issues are neither recorded nor emailed until the variable is set.
- The worker also logs every freshly-alerted issue to stderr (`console.warn`) regardless of email delivery, as a local fallback signal.

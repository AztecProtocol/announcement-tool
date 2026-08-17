# aztec-announce

Release-only announcement pipeline (author once → fan out).

**Concept doc:** [announcement-tool-concept.md](../announcement-tool-concept.md) — design rationale, feature scope, architecture.  
**Follow-on plans:** Plan 2 adds channel adapters (Discord/Telegram/Email/Signal) + health alerting; Plan 3 adds public web (subscribe page, archive, feeds); Plan 4 adds admin UI; Plan 5 covers deployment and Tailscale integration.

## Development Setup

**Prerequisites:** Docker, Node 22+, npm.

```bash
# Start the dev Postgres database (runs on :5499)
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
npm install

# Run migrations
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
    "published_at": "2026-08-06T10:00:00Z",
    "expires_at": "2026-08-20T14:00:00Z"
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

The worker registers one adapter per channel at startup: `webhook`, `discord`, `telegram`, `email`, `signal`. Delivery targets are matched to subscriptions/settings by the `target` key on each `delivery_ledger` row; for webhook and email, `target` is a subscription id (`subscriptions` table). For discord, telegram, and signal, `target` is a `channel_settings.key` — there is no self-serve subscribe flow for these three, so destinations are configured directly in Postgres (see the worked example below). Admin-editable channel settings are Plan 4 scope.

### Discord

Posts to a Discord incoming webhook URL. Configured via a `channel_settings` row with `channel = 'discord'`:

```sql
insert into channel_settings (key, channel, config) values
  ('discord:mainnet-updates', 'discord', '{
     "networks": ["mainnet"], "types": ["upgrade","info"],
     "webhook_url": "https://discord.com/api/webhooks/...",
     "prefix": "<@&MAINNET_SEQUENCER_ROLE_ID> <@&GENESIS_SEQUENCER_ROLE_ID>",
     "username": "Aztec Announcements"
   }');
```

- `webhook_url` (required) — the Discord incoming webhook URL for the target channel.
- `prefix` (optional) — raw text prepended to the message body, on its own line. Used for role-mention pings (`<@&ROLE_ID>`) or an emoji preamble; sent as-is, so it must already contain valid Discord mention syntax. The adapter sets `allowed_mentions: { parse: ["roles", "everyone"] }` so role mentions in `prefix` actually notify.
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
- **Env vars:** `SIGNAL_ACCOUNT` (required) — the registered sender number, e.g. `+15551234567`. `SIGNAL_API_BASE` (default `http://127.0.0.1:8080`) — base URL of the sidecar.
- **Failure mode:** any non-2xx response from the sidecar throws (with body text appended) and retries under standard backoff; a missing `SIGNAL_ACCOUNT` fails every attempt identically.

## Configuration

Copy `.env.example` to `.env` and fill in what each channel needs. All values below are defaults or placeholders — no live secrets.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgres://announce:announce@127.0.0.1:5499/announce` | Postgres connection string used by the worker and migrations. |
| `PUBLIC_BASE_URL` | `https://announce.aztec.foundation` | Base URL used to build the email unsubscribe link (`/u/<token>`). |
| `TELEGRAM_BOT_TOKEN` | *(unset)* | Bot token from BotFather; required for any Telegram delivery. |
| `SIGNAL_API_BASE` | `http://127.0.0.1:8080` | Base URL of the `signal-cli-rest-api` sidecar. |
| `SIGNAL_ACCOUNT` | *(unset)* | Registered Signal sender number; required for any Signal delivery. |
| `ESP_PROVIDER` | `console` | Email Sending Provider: `console` (logs to stdout, dev default) \| `resend` (dev/staging) \| `brevo` (prod). |
| `EMAIL_FROM` | *(unset)* | From address; required by both `resend` and `brevo` providers. |
| `EMAIL_FROM_NAME` | `Aztec Announcements` | From display name; used by `brevo` only. |
| `RESEND_API_KEY` | *(unset)* | Required when `ESP_PROVIDER=resend`. |
| `BREVO_API_KEY` | *(unset)* | Required when `ESP_PROVIDER=brevo`. |
| `ALERT_EMAIL_TO` | *(unset)* | Destination address for channel-health alert emails. Not in `.env.example` (opt-in). Unset disables alerting entirely — see Alerting below. |

Discord, Telegram, and Signal *destinations* (webhook URLs, chat/group ids) are not environment variables — they live in `channel_settings` rows, since a deployment typically has more than one destination per channel.

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

Every admin route resolves the caller's identity from request headers (`src/core/identity.ts`):

- In production, identity comes from Tailscale's `Tailscale-User-Login` proxy header (plus optional `Tailscale-User-Name`). This is sound **only** because the app binds to `localhost` and `tailscale serve` is the sole route in — if the port were ever exposed directly, these headers could be forged by any caller.
- In development, set `ADMIN_EMAIL` and it is used as a fallback identity when no Tailscale header is present.
- If neither is present, the admin layout renders an access-denied page instead of the requested content.

### Publishers and the bootstrap rule

`app/admin/layout.tsx` checks the resolved identity against the `publishers` table (`isPublisher` in `src/core/identity.ts`) before rendering any admin page, so a non-publisher tailnet identity cannot read drafts, requester emails, fan-out targets, or templates either. Each mutating server action in `app/admin/actions.ts` also runs its own `isPublisher` check independently — the layout is not the only enforcement point for writes.

- **Bootstrap rule:** if the `publishers` table is empty, every identity is treated as a publisher. This exists so the first deployment isn't locked out before anyone has been added.
- While the table is empty, the admin shell shows a standing warning: "No publishers configured — anyone reaching this page can publish. Add publishers before launch."
- **Publishers must be added to the table before launch.** Once at least one row exists, only listed emails may compose, preview, or publish.
- If the publisher lookup itself fails (e.g. database unreachable), the layout fails closed and shows an "Admin is unavailable" page rather than falling through to open access.

### Compose, preview, publish

1. **Compose** (`/admin`) — a form with type/network/audience/severity selectors, a Markdown body with a formatting toolbar, repeatable "actions required" and "links" fields, and an optional expiry date. Submitting creates a draft (`createDraft`) and redirects to its review page.
2. **Review** (`/admin/review/<id>`) — shows a live per-channel preview (webhook JSON, Discord/Telegram/Signal message text including any configured Discord role-mention prefix, email rendering) and the publish control.

### Preview modes

Each channel tab has two modes.

**Rendered** approximates what a reader sees on that platform: headings appear as headings, bold as bold, inline code as a monospace chip, and Discord role mentions as pills. Use this mode to check the announcement reads well.

**Raw payload** shows the exact string sent to that channel. Use this mode to verify what actually goes on the wire.

For Discord, the raw payload is the authoritative view. It shows the configured channel prefix — role mentions and the emoji preamble — exactly as it will be posted. Because Discord messages are sent with role and everyone mentions enabled, always read the raw Discord payload before publishing and confirm the mentions are the ones you intend.

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
webhook the same text arrives as literal characters a reader cannot act on.

Configure mentions as part of the Discord channel prefix instead, with
`npm run setup:channel`. The prefix is stored per Discord channel and is read
only by the Discord adapter, so it reaches no other channel. The compose form
warns if it finds a mention in the body.

Read the raw Discord preview before publishing to confirm the prefix is the one
you intend.

3. **Publish:**
   - **Non-critical** severity publishes in one step — "Publish now" calls `requestPublish`, which publishes immediately and enqueues deliveries.
   - **Critical** severity requires two different publishers (four-eyes): "Request publication" moves the draft to `publish_requested`. The requester sees a waiting state; any *other* publisher sees "Confirm and publish". If the same identity that requested tries to confirm, `confirmPublish` throws `FourEyesError` and the review page shows it as an inline error, not a crash.

### Templates and starting points

The compose page (`/admin?from=template:<id>` or `?from=announcement:<id>`) can prefill the form three ways:

- **Blank** — the default, empty form.
- **Saved template** — pick from the "Saved templates" dropdown, sourced from the `templates` table. Any draft can be saved as a template from the compose form ("Save as template").
- **Past announcement** — start from a previously published announcement (`listPublished`), reusing its text, type, networks, audiences, and severity.

In both prefill cases, **all dates are cleared** — `expiresAt` and every action's `deadline` — so a reused announcement can never carry a stale, already-past deadline into a new draft. The form shows a note when prefilled: "Dates (deadlines, expiry) are cleared — set new ones below."

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

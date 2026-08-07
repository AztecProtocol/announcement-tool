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
| `src/worker/fanout.ts` | Main fan-out loop (drain outbox, retry logic, ledger updates) |
| `src/worker/main.ts` | Worker entry point (15s interval + health logging) |
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

export const metadata = {
  title: 'Webhook docs — Aztec release announcements',
};

export default function WebhookDocsPage() {
  return (
    <>
      <h1>Webhook consumer docs</h1>
      <p>Register an endpoint on the <a href="/">subscribe page</a>. Deliveries are POSTed as they publish — no polling.</p>

      <h2>Payload</h2>
      <p>Every delivery is a POST with this JSON body:</p>
      <pre>{`{
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
}`}</pre>
      <p><code>kind</code> is <code>publish</code>, <code>update</code>, or <code>reminder</code> for real deliveries. Registration also sends a one-off verification event with <code>kind: "test"</code> — see below.</p>

      <h2>Headers</h2>
      <table>
        <thead><tr><th>Header</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td><code>x-announce-event-id</code></td><td>Same value as <code>event_id</code> in the body</td></tr>
          <tr><td><code>x-announce-timestamp</code></td><td>Unix seconds (integer), as a string</td></tr>
          <tr><td><code>x-announce-signature</code></td><td><code>v1=&lt;hex&gt;</code> — see Signature verification below</td></tr>
        </tbody>
      </table>

      <h2>Signature verification</h2>
      <p>
        Compute <code>v1=hex(hmac_sha256(secret, timestamp + "." + body))</code> over the raw request body
        (before any JSON parsing) and compare it to <code>x-announce-signature</code>.
      </p>
      <pre>{`import { createHmac } from 'node:crypto';

const secret = '...your webhook secret...';
const timestamp = req.headers['x-announce-timestamp'];
const signature = req.headers['x-announce-signature'];
const body = req.rawBody; // raw request body as a string, not the parsed JSON

const expected = 'v1=' + createHmac('sha256', secret)
  .update(\`\${timestamp}.\${body}\`)
  .digest('hex');

if (signature !== expected) {
  throw new Error('invalid signature');
}`}</pre>

      <h2>Retries</h2>
      <p>
        Up to 5 delivery attempts per event. Failed attempts back off 2, 5, 10, 20, then 30 minutes before the next
        try. After the 5th failed attempt the delivery is marked <code>exhausted</code> and not retried further.
      </p>

      <h2>Idempotency</h2>
      <p>
        Retries and, rarely, redelivery can send the same event more than once. Dedupe on <code>event_id</code> —
        it is stable across attempts for a given announcement, revision, and delivery kind.
      </p>

      <h2>Verification test event</h2>
      <p>
        When you register a webhook, a verification request is sent immediately with <code>kind: "test"</code> and
        an <code>event_id</code> of the form <code>whtest_&lt;subscription_id&gt;</code>, signed the same way as a
        real delivery. Your endpoint must respond with a 2xx status for the registration to succeed — a non-2xx
        response or a network error is reported back on the subscribe page and the webhook is not activated.
      </p>

      <div className="notice">
        <p>Keep the secret private — anyone with it can forge signed payloads to your endpoint. Registration also returns a one-time unsubscribe link — save it. To rotate the secret, open that unsubscribe link to remove the registration, then re-register; there is no in-place secret rotation.</p>
      </div>
    </>
  );
}

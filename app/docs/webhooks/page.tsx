export const metadata = {
  title: 'Webhook docs — Aztec release announcements',
};

export default function WebhookDocsPage() {
  return (
    <>
      <h1>Webhook consumer documentation</h1>
      <p>Register an endpoint on the <a href="/">subscribe page</a>. The tool sends a POST request to your endpoint for each announcement. You do not poll.</p>

      <h2>Your secret</h2>
      <p>The subscribe page shows your secret one time, directly after registration. Copy it and store it in a safe place. The tool does not show it again.</p>
      <p>Warning: a person who has the secret can send signed requests to your endpoint. Keep it private.</p>
      <p>To replace the secret, open the unsubscribe link that the page shows with the secret, then register again. The tool has no in-place secret rotation.</p>

      <h2>Payload</h2>
      <p>Each delivery is a POST request with this JSON body:</p>
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
      <p>The <code>kind</code> field is <code>publish</code>, <code>update</code> or <code>reminder</code> for a real delivery. Registration sends one test event with <code>kind: "test"</code>. See "Verification test event" below.</p>

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
      <p>Compute <code>v1=hex(hmac_sha256(secret, timestamp + "." + body))</code>. Use the raw request body, before JSON parsing. Compare the result with the <code>x-announce-signature</code> header. Reject the request if they are different.</p>
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
      <p>The tool makes up to 5 delivery attempts for each event. After a failed attempt, the tool waits 2, 5, 10, 20 and then 30 minutes before the next attempt. After the fifth failed attempt, the tool marks the delivery as <code>exhausted</code> and stops.</p>

      <h2>Idempotency</h2>
      <p>A retry can send the same event more than one time. Use <code>event_id</code> to identify duplicates. The value is the same for each attempt of one announcement, revision and delivery kind.</p>

      <h2>Verification test event</h2>
      <p>When you register a webhook, the tool sends one test request at once. The request has <code>kind: "test"</code> and an <code>event_id</code> of the form <code>whtest_&lt;subscription_id&gt;</code>. The signature is the same as for a real delivery.</p>
      <p>Your endpoint must answer with a 2xx status. If the answer is not 2xx, or the request fails, the subscribe page shows the error and the webhook is not active.</p>
    </>
  );
}

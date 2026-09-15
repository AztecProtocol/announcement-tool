'use client';
import { useActionState } from 'react';
import { subscribeWebhook, testWebhook } from './actions.js';
import type { AnnouncementType, Audience, Network, Severity } from '../src/core/types.js';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

type Result = { secretOnce?: string; manageUrl?: string; verified: boolean; error?: string };
type TestResult = { verified: boolean; error?: string };

async function action(_prev: Result | undefined, formData: FormData): Promise<Result> {
  return subscribeWebhook(formData);
}
async function testAction(_prev: TestResult | undefined, formData: FormData): Promise<TestResult> {
  return testWebhook(formData);
}

const box = (name: string, value: string, checked: boolean) => (
  <label className="check" key={value}>
    <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
  </label>
);

function TestButton({ token }: { token: string }) {
  const [result, formAction, pending] = useActionState<TestResult | undefined, FormData>(testAction, undefined);
  return (
    <form action={formAction}>
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={pending || result?.verified === true}>
        {pending ? 'Sending…' : 'Send test event'}
      </button>
      {result?.verified && <p><strong>✅ Test passed. The webhook is active.</strong></p>}
      {result && !result.verified && <p><strong>❌ Test failed.</strong> {result.error}</p>}
    </form>
  );
}

export default function WebhookForm() {
  const [result, formAction, pending] = useActionState<Result | undefined, FormData>(action, undefined);
  const token = result?.manageUrl?.split('/').pop();

  return (
    <div className="card">
      <h2>Webhook</h2>
      <p className="muted">POST delivery with HMAC-SHA256 signing — see the <a href="/docs/webhooks">webhook docs</a> for payload shape and verification.</p>
      <form action={formAction}>
        <label htmlFor="webhook-url">Endpoint URL</label>
        <input id="webhook-url" type="url" name="url" placeholder="https://example.com/webhooks/aztec-announce" required />
        <fieldset><legend>Networks</legend>{NETWORKS.map(v => box('networks', v, v === 'mainnet'))}</fieldset>
        <fieldset><legend>Types</legend>{TYPES.map(v => box('types', v, v !== 'info'))}</fieldset>
        <fieldset><legend>Severities</legend>{SEVERITIES.map(v => box('severities', v, v !== 'info'))}</fieldset>
        <fieldset><legend>Audience</legend>{AUDIENCES.map(v => box('audiences', v, v === 'operators'))}</fieldset>
        <button type="submit" disabled={pending}>{pending ? 'Registering…' : 'Register webhook'}</button>
      </form>

      {result && (
        <div className="notice" style={{ marginTop: 16 }}>
          {result.error && <p>Error: {result.error}</p>}
          {result.secretOnce && token && (
            <>
              <p><strong>Registered. Not active yet.</strong></p>
              <p>Webhook secret — shown only once:</p>
              <pre>{result.secretOnce}</pre>
              <p>Webhook page — keep this link, it is the only way back to this webhook:</p>
              <pre>{result.manageUrl}</pre>
              <p>Do this now, in this order:</p>
              <ol>
                <li>Put the secret in your webhook configuration. Your endpoint uses it to check the <code>x-announce-signature</code> header on every request.</li>
                <li>Store the webhook page link somewhere safe. Anyone with the link can remove the webhook.</li>
                <li>When your endpoint has the secret, click <strong>Send test event</strong> below. Your endpoint must answer with a 2xx status. The webhook becomes active only after a passed test.</li>
              </ol>
              {/* key={token} forces a remount on a new registration in the
                  same page session — without it useActionState keeps the
                  previous webhook's pass/fail line and disabled state
                  showing under the new secret/link. */}
              <TestButton key={token} token={token} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

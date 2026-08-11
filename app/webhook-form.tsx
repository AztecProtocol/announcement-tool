'use client';
import { useActionState } from 'react';
import { subscribeWebhook } from './actions.js';
import type { AnnouncementType, Audience, Network, Severity } from '../src/core/types.js';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

type Result = { secretOnce?: string; unsubscribeUrl?: string; verified: boolean; error?: string };

async function action(_prev: Result | undefined, formData: FormData): Promise<Result> {
  return subscribeWebhook(formData);
}

const box = (name: string, value: string, checked: boolean) => (
  <label className="check" key={value}>
    <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
  </label>
);

export default function WebhookForm() {
  const [result, formAction, pending] = useActionState<Result | undefined, FormData>(action, undefined);

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
          <p><strong>{result.verified ? 'Verified' : 'Not verified'}</strong></p>
          {result.error && <p>Error: {result.error}</p>}
          {result.secretOnce && (
            <>
              <p>Save both — shown only once. Store the secret to verify deliveries, and keep the unsubscribe link to stop or rotate this webhook later.</p>
              <pre>{result.secretOnce}</pre>
              {result.unsubscribeUrl && <pre>{result.unsubscribeUrl}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

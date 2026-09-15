import { redirect } from 'next/navigation';
// Deep import, not 'next/headers' — see the tsconfig "paths" comment: the public
// specifier does not resolve under NodeNext, and a paths mapping to the .d.ts
// makes the call compile to `(void 0)()` at runtime under Turbopack.
import { headers } from 'next/dist/server/request/headers.js';
import { getDb } from '../../../src/web/db.js';
import { getSubscriptionByUnsubscribeToken } from '../../../src/core/subscriptions.js';
import { updateFiltersByToken } from '../../../src/core/tokens-flow.js';
import { sendWebhookTest } from '../../../src/core/webhook-flow.js';
import { consumeRateLimit, RATE_LIMITS } from '../../../src/core/rate-limit.js';
import { clientIpFromHeaders } from '../../../src/web/client-ip.js';
import type { AnnouncementType, Audience, Network, Severity } from '../../../src/core/types.js';

export const dynamic = 'force-dynamic';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

export default async function ManagePage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ saved?: string; error?: string; tested?: string }>;
}) {
  const { token } = await params;
  const { saved, error, tested } = await searchParams;
  const sub = await getSubscriptionByUnsubscribeToken(getDb(), token);
  if (!sub) {
    return (<><h1>Link not recognized</h1><p>This link is invalid or the subscription no longer exists.</p></>);
  }

  async function save(formData: FormData): Promise<void> {
    'use server';
    const pick = (name: string): string[] => formData.getAll(name).map(String);
    const f = {
      networks: pick('networks') as Network[], types: pick('types') as AnnouncementType[],
      severities: pick('severities') as Severity[], audiences: pick('audiences') as Audience[],
    };
    // Every group needs at least one box ticked — an empty group would mean
    // "receive nothing", which is what unsubscribing is for.
    const empty = Object.entries(f).filter(([, v]) => v.length === 0).map(([k]) => k);
    if (empty.length > 0) redirect(`/manage/${token}?error=${encodeURIComponent(empty.join(','))}`);
    await updateFiltersByToken(getDb(), token, f);
    redirect(`/manage/${token}?saved=1`);
  }

  async function test(): Promise<void> {
    'use server';
    const sql = getDb();
    const ip = clientIpFromHeaders(await headers());
    const byIp = await consumeRateLimit(sql, `webhook:test:ip:${ip}`, RATE_LIMITS.webhookTestPerIp);
    const bySub = byIp.allowed && await consumeRateLimit(sql, `webhook:test:sub:${token}`, RATE_LIMITS.webhookTestPerSub);
    if (!byIp.allowed || !bySub || !bySub.allowed) redirect(`/manage/${token}?tested=limit`);
    const r = await sendWebhookTest(sql, { token });
    redirect(`/manage/${token}?tested=${r.verified ? 'ok' : 'fail'}`);
  }

  const box = (name: string, value: string, checked: boolean) => (
    <label className="check" key={value}>
      <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
    </label>
  );

  return (
    <>
      <h1>{sub.channel === 'webhook' ? 'Your webhook' : 'Your announcement preferences'}</h1>
      {sub.channel === 'webhook' && (
        <section className="notice">
          <p><strong>Webhook</strong> <code>{sub.endpoint}</code></p>
          <p>Status: {sub.verified
            ? <strong>Active</strong>
            : <><strong>Not active</strong> — no passed test yet.</>}</p>
          {tested === 'ok' && <p><strong>✅ Test passed. The webhook is active.</strong></p>}
          {tested === 'fail' && <p><strong>❌ Test failed.</strong> The endpoint did not respond with a 2xx status. Check that your endpoint has the secret and is reachable from the internet, then click Send test event again.</p>}
          {tested === 'limit' && <p>Too many test events. Try again in an hour.</p>}
          <form action={test} style={{ display: 'inline' }}>
            <button type="submit">Send test event</button>
          </form>{' '}
          <a href={`/u/${token}`}>Remove webhook</a>
          <p className="muted">The secret was shown once at registration. If you lost it, remove this webhook and register the URL again to get a new one.</p>
        </section>
      )}
      {saved === '1' && (
        <div className="notice"><p>Preferences saved. You now receive: {sub.filters.networks.join(', ')} · {sub.filters.types.join(', ')} · {sub.filters.severities.join(', ')}.</p></div>
      )}
      {error && (
        <div className="notice"><p>Nothing was saved — pick at least one option under: {error.split(',').join(', ')}. To stop all announcements, use Unsubscribe below.</p></div>
      )}
      <form action={save}>
        <fieldset><legend>Networks</legend>{NETWORKS.map(v => box('networks', v, sub.filters.networks.includes(v)))}</fieldset>
        <fieldset><legend>Types</legend>{TYPES.map(v => box('types', v, sub.filters.types.includes(v)))}</fieldset>
        <fieldset><legend>Severities</legend>{SEVERITIES.map(v => box('severities', v, sub.filters.severities.includes(v)))}</fieldset>
        <fieldset><legend>Audience</legend>{AUDIENCES.map(v => box('audiences', v, sub.filters.audiences.includes(v)))}</fieldset>
        <button type="submit">Save preferences</button>{' '}
        <a href={`/u/${token}`}>{sub.channel === 'webhook' ? 'Remove webhook' : 'Unsubscribe entirely'}</a>
      </form>
    </>
  );
}

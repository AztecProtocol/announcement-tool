import { redirect } from 'next/navigation';
import { getDb } from '../../../src/web/db.js';
import { getSubscriptionByUnsubscribeToken } from '../../../src/core/subscriptions.js';
import { updateFiltersByToken } from '../../../src/core/tokens-flow.js';
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
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { token } = await params;
  const { saved, error } = await searchParams;
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

  const box = (name: string, value: string, checked: boolean) => (
    <label className="check" key={value}>
      <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
    </label>
  );

  return (
    <>
      <h1>Your announcement preferences</h1>
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
        <a href={`/u/${token}`}>Unsubscribe entirely</a>
      </form>
    </>
  );
}

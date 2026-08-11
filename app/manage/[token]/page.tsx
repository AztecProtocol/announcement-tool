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

export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
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
    for (const v of Object.values(f)) if (v.length === 0) return; // form guard; page re-renders unchanged
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

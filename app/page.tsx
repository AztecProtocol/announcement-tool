import { subscribeEmail } from './actions.js';
import WebhookForm from './webhook-form.js';
import { broadcastLinks } from '../src/web/broadcast-links.js';
import type { AnnouncementType, Audience, Network, Severity } from '../src/core/types.js';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

const box = (name: string, value: string, checked: boolean) => (
  <label className="check" key={value}>
    <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
  </label>
);

export default async function SubscribePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  // Defaults: both networks, upgrade + governance types (info unchecked),
  // critical + recommended severities (info unchecked), operators only.
  const isNetworkChecked = (_v: Network) => true;
  const isTypeChecked = (v: AnnouncementType) => v !== 'info';
  const isSeverityChecked = (v: Severity) => v !== 'info';
  const isAudienceChecked = (v: Audience) => v === 'operators';
  const links = broadcastLinks(process.env);

  return (
    <>
      <h1>Get Aztec release announcements</h1>
      <p>Upgrades, governance events and operational notices.</p>

      {error === 'email' && (
        <div className="notice"><p>Enter a valid email address.</p></div>
      )}
      {error === 'rate' && (
        <div className="notice"><p>Too many requests. Try again in an hour.</p></div>
      )}

      <div className="card">
        <h2>Email</h2>
        <form action={subscribeEmail}>
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" name="email" placeholder="you@example.com" required />
          <fieldset><legend>Networks</legend>{NETWORKS.map(v => box('networks', v, isNetworkChecked(v)))}</fieldset>
          <fieldset><legend>Types</legend>{TYPES.map(v => box('types', v, isTypeChecked(v)))}</fieldset>
          <fieldset><legend>Severities</legend>{SEVERITIES.map(v => box('severities', v, isSeverityChecked(v)))}</fieldset>
          <fieldset><legend>Audience</legend>{AUDIENCES.map(v => box('audiences', v, isAudienceChecked(v)))}</fieldset>
          <button type="submit">Subscribe by email</button>
        </form>
      </div>

      <WebhookForm />

      {links.length > 0 && (
        <div className="card">
          <h2>Broadcast channels</h2>
          <p className="muted">These carry every announcement. For filtered delivery, use email or webhook above.</p>
          <ul className="plain">
            {links.map(l => (
              <li key={l.label}>
                <a href={l.url} rel="noopener noreferrer">{l.label}</a>
                {l.note && <span className="muted"> — {l.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted">Building an integration? See the <a href="/docs/webhooks">webhook consumer docs</a>.</p>
    </>
  );
}

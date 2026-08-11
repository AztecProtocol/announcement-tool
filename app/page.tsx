import { subscribeEmail } from './actions.js';
import WebhookForm from './webhook-form.js';
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

export default async function SubscribePage({ searchParams }: { searchParams: Promise<{ preset?: string; error?: string }> }) {
  const { preset, error } = await searchParams;
  const criticalsOnly = preset === 'criticals';

  // Default: both networks, upgrade + governance types (info unchecked),
  // critical + recommended severities (info unchecked), operators only.
  // Criticals-only preset: mainnet + critical only, both types, operators only.
  const isNetworkChecked = (v: Network) => (criticalsOnly ? v === 'mainnet' : true);
  const isTypeChecked = (v: AnnouncementType) => (criticalsOnly ? true : v !== 'info');
  const isSeverityChecked = (v: Severity) => (criticalsOnly ? v === 'critical' : v !== 'info');
  const isAudienceChecked = (v: Audience) => v === 'operators';

  return (
    <>
      <h1>Get Aztec release announcements</h1>
      <p>Upgrades, governance events and operational notices — release-only, a few messages a month, nothing else.</p>

      <p>
        <a
          href="/?preset=criticals"
          className="secondary"
          style={{
            display: 'inline-block', fontWeight: 600, padding: '9px 18px', borderRadius: 7,
            border: '1px solid #3a5a78', background: '#fff', color: '#3a5a78', textDecoration: 'none',
          }}
        >
          Release-criticals only — mainnet
        </a>
      </p>

      {error === 'email' && (
        <div className="notice"><p>Enter a valid email address.</p></div>
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

      <div className="card">
        <h2>Broadcast channels</h2>
        <p className="muted">These carry everything, release-only — for filtered delivery use email or webhook above.</p>
        <ul className="plain">
          <li><a href="#">Discord</a></li>
          <li><a href="#">Telegram</a></li>
          <li><a href="#">Signal</a></li>
        </ul>
        <p className="muted">Official handles are published at launch.</p>
      </div>

      <p className="muted">Building an integration? See the <a href="/docs/webhooks">webhook consumer docs</a>.</p>
    </>
  );
}

import { notFound } from 'next/navigation';
// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/layout.tsx (tsconfig.json `paths` breaks Turbopack's dev resolver
// for that specifier).
import { headers } from 'next/dist/server/request/headers.js';
import { getDb } from '../../../../src/web/db.js';
import { resolveIdentity } from '../../../../src/core/identity.js';
import { getLatest } from '../../../../src/core/announcements.js';
import { countFanoutTargets } from '../../../../src/core/outbox.js';
import { renderBodyHtml, formatDeadline } from '../../../../src/core/render.js';
import type { Network } from '../../../../src/core/types.js';
import PublishControl from './publish-control.js';

export const metadata = {
  title: 'Review — Admin',
};

export const dynamic = 'force-dynamic';

const NETWORK_ORDER: Network[] = ['mainnet', 'testnet'];

/** "discord:mainnet-updates" -> "#mainnet-updates"; other channels pass through their target as-is. */
function destinationLabel(channel: string, target: string): string {
  const key = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target;
  if (channel === 'discord') return `Discord #${key}`;
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'signal') return 'Signal';
  return channel;
}

function fanoutSummary(targets: { channel: string; target: string }[]): string[] {
  const broadcast = targets.filter(t => t.channel === 'discord' || t.channel === 'telegram' || t.channel === 'signal');
  const email = targets.filter(t => t.channel === 'email').length;
  const webhook = targets.filter(t => t.channel === 'webhook').length;

  const lines: string[] = [];
  for (const t of broadcast) lines.push(destinationLabel(t.channel, t.target));
  if (email > 0) lines.push(`${email} email subscriber${email === 1 ? '' : 's'}`);
  if (webhook > 0) lines.push(`${webhook} webhook${webhook === 1 ? '' : 's'}`);
  return lines;
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const identity = resolveIdentity(await headers());
  const a = await getLatest(db, id);
  if (!a) notFound();

  const targets = await countFanoutTargets(db, a);
  const summary = fanoutSummary(targets);

  const sevClass = a.severity === 'critical' ? '' : ` sev-${a.severity}`;

  return (
    <article>
      <h1 className="muted" style={{ fontFamily: 'var(--sans)', fontSize: 14 }}>Review before publishing</h1>

      <div className="card">
        <ul className="tags">
          {NETWORK_ORDER.filter(n => a.networks.includes(n)).map(n => (
            <li key={n} className="tag tag-network">{n}</li>
          ))}
          <li className={`tag tag-${a.severity}`}>{a.severity}</li>
          <li className="tag">{a.type}</li>
          <li className="tag">{a.status}</li>
        </ul>

        <h1>{a.title}</h1>

        <div className="announcement-body" dangerouslySetInnerHTML={{ __html: renderBodyHtml(a.bodyMd) }} />

        {a.actionsRequired.length > 0 && (
          <div className={`actions${sevClass}`}>
            <span className="actions-label">Action required</span>
            <ul>
              {a.actionsRequired.map((act, i) => (
                <li key={i}>
                  {act.action}
                  {act.deadline ? <> — by <strong>{formatDeadline(act.deadline)}</strong></> : null}
                  {act.applies_to.length ? <> ({act.applies_to.join(', ')})</> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {a.links.length > 0 && (
          <p>{a.links.map((l, i) => <span key={i}>{i > 0 && ' · '}<a href={l.url}>{l.label}</a></span>)}</p>
        )}
      </div>

      {/* A discarded announcement will never send, so a destination list under
          any heading reads as a pending send. Suppress the card entirely rather
          than relabel it. For a published one the send already happened, so the
          heading is past tense; for anything else it is still ahead. */}
      {a.status !== 'discarded' && (
        <div className="card">
          <h2>{a.status === 'published' ? 'Sent to' : 'Will send to'}</h2>
          {summary.length === 0 ? (
            <p className="muted">No destinations match this announcement&apos;s network and type.</p>
          ) : (
            <p>{summary.join(' · ')}</p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Publish</h2>
        <PublishControl announcement={a} viewerEmail={identity?.email} />
      </div>
    </article>
  );
}

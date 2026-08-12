import { notFound } from 'next/navigation';
import { getDb } from '../../../src/web/db.js';
import { getPublishedBySlug } from '../../../src/core/queries.js';
import { renderBodyHtml, formatDeadline } from '../../../src/core/render.js';
import type { Network } from '../../../src/core/types.js';

export const dynamic = 'force-dynamic';

const NETWORK_ORDER: Network[] = ['mainnet', 'testnet'];

export default async function AnnouncementPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await getPublishedBySlug(getDb(), slug);
  if (!a) notFound();

  // The action box takes the announcement's severity, so "must act tonight"
  // and "nothing to do" never look alike.
  const sevClass = a.severity === 'critical' ? '' : ` sev-${a.severity}`;

  return (
    <article>
      <ul className="tags">
        {NETWORK_ORDER.filter(n => a.networks.includes(n)).map(n => (
          <li key={n} className="tag tag-network">{n}</li>
        ))}
        <li className={`tag tag-${a.severity}`}>{a.severity}</li>
        <li className="tag">{a.type}</li>
      </ul>

      <h1>{a.title}</h1>
      <p className="meta">Published {a.publishedAt ? formatDeadline(a.publishedAt) : ''}</p>

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
    </article>
  );
}

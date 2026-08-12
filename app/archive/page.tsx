import { getDb } from '../../src/web/db.js';
import { listPublished } from '../../src/core/queries.js';
import { formatDeadline } from '../../src/core/render.js';
import type { Network } from '../../src/core/types.js';

export const dynamic = 'force-dynamic';

const NETWORK_ORDER: Network[] = ['mainnet', 'testnet'];

export default async function ArchivePage() {
  const announcements = await listPublished(getDb(), 100);
  return (
    <>
      <h1>Archive</h1>
      <p className="muted">Every announcement published, newest first. Also available as <a href="/feed.json">JSON</a> or <a href="/feed.atom">Atom</a>.</p>
      {announcements.length === 0 && <p className="muted">No announcements published yet.</p>}
      <ul className="plain">
        {announcements.map(a => (
          <li key={a.id}>
            <ul className="tags">
              {NETWORK_ORDER.filter(n => a.networks.includes(n)).map(n => (
                <li key={n} className="tag tag-network">{n}</li>
              ))}
              <li className={`tag tag-${a.severity}`}>{a.severity}</li>
              <li className="tag">{a.type}</li>
            </ul>
            <a href={`/a/${a.slug}`}>{a.title}</a>
            <p className="meta" style={{ margin: '5px 0 0' }}>
              {a.publishedAt ? formatDeadline(a.publishedAt) : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

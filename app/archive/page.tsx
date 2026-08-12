import { getDb } from '../../src/web/db.js';
import { listPublished } from '../../src/core/queries.js';
import { tagLine, formatDeadline } from '../../src/core/render.js';

export const dynamic = 'force-dynamic';

export default async function ArchivePage() {
  const announcements = await listPublished(getDb(), 100);
  return (
    <>
      <h1>Archive</h1>
      {announcements.length === 0 && <p className="muted">No announcements published yet.</p>}
      <ul className="plain">
        {announcements.map(a => (
          <li key={a.id}>
            <p className="tags">{tagLine(a)} · {a.publishedAt ? formatDeadline(a.publishedAt) : ''}</p>
            <a href={`/a/${a.slug}`}><strong>{a.title}</strong></a>
          </li>
        ))}
      </ul>
    </>
  );
}

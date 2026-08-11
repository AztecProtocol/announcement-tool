import { notFound } from 'next/navigation';
import { getDb } from '../../../src/web/db.js';
import { getPublishedBySlug } from '../../../src/core/queries.js';
import { tagLine, renderBodyHtml } from '../../../src/core/render.js';

export const dynamic = 'force-dynamic';

export default async function AnnouncementPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await getPublishedBySlug(getDb(), slug);
  if (!a) notFound();
  return (
    <article>
      <p className="tags">{tagLine(a)}</p>
      <h1>{a.title}</h1>
      <p className="muted">Published {a.publishedAt ? new Date(a.publishedAt).toUTCString() : ''}</p>
      <div className="announcement-body" dangerouslySetInnerHTML={{ __html: renderBodyHtml(a.bodyMd) }} />
      {a.actionsRequired.length > 0 && (
        <div className="notice">
          <strong>Action required</strong>
          <ul>
            {a.actionsRequired.map((act, i) => (
              <li key={i}>
                {act.action}
                {act.deadline ? <> — by <strong>{act.deadline}</strong></> : null}
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

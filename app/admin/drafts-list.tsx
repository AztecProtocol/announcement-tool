import DiscardButton from './discard-button.js';

export interface DraftItem {
  id: string;
  title: string;
  severity: string;
  publishRejectedBy?: string;
  publishRejectedReason?: string;
}

/**
 * Lists every draft, including one returned by a rejection, so it is
 * reachable from somewhere other than a review URL nothing links to. Without
 * this list a rejected draft is invisible: not on the archive (published
 * only), not in the pending queue (publish_requested only), not discarded —
 * just an orphaned row holding its slug.
 */
export default function DraftsList({ items }: { items: DraftItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="drafts-list" aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Drafts ({items.length})</h2>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            <div className="drafts-main">
              <span className="drafts-title">{item.title}</span>
              <span className="drafts-meta">
                {item.severity}
                {item.publishRejectedBy
                  ? ` — rejected by ${item.publishRejectedBy}${
                      item.publishRejectedReason ? `: ${item.publishRejectedReason}` : ''
                    }`
                  : ''}
              </span>
            </div>
            <span className="drafts-controls">
              <a className="pending-action" href={`/admin?from=edit:${item.id}`}>
                Edit
              </a>
              <DiscardButton id={item.id} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

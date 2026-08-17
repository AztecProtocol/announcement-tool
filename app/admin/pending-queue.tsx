export interface PendingItem {
  id: string;
  title: string;
  severity: string;
  requestedBy?: string;
}

/**
 * Shown at the top of the admin landing page so a second publisher can find
 * what needs confirming. Without it, four-eyes depends on someone pasting a
 * review URL into a chat.
 */
export default function PendingQueue({ items, viewer }: { items: PendingItem[]; viewer: string }) {
  if (items.length === 0) return null;
  return (
    <section className="pending-queue" aria-labelledby="pending-heading">
      <h2 id="pending-heading">Awaiting confirmation ({items.length})</h2>
      <ul>
        {items.map(item => {
          const isRequester = item.requestedBy === viewer;
          // Only `severity === 'critical'` actually blocks self-confirmation
          // server-side (src/core/announcements.ts's confirmPublish). Today
          // every row here is critical anyway — listAwaitingConfirmation can
          // only return critical announcements, since a non-critical one
          // publishes immediately and never reaches publish_requested — but
          // that's a fact about the current caller, not this component. Gate
          // the message on the same condition the server enforces so the
          // component stays correct if it's ever fed a broader status list.
          const blockedBySelfConfirm = isRequester && item.severity === 'critical';
          return (
            <li key={item.id}>
              <div className="pending-main">
                <span className="pending-title">{item.title}</span>
                <span className="pending-meta">
                  {item.severity} · requested by {item.requestedBy ?? 'unknown'}
                  {blockedBySelfConfirm ? ' — you cannot confirm your own request' : ''}
                </span>
              </div>
              <a className="pending-action" href={`/admin/review/${item.id}`}>
                {isRequester ? 'View' : 'Review'}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

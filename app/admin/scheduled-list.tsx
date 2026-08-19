import CancelScheduleButton from './cancel-schedule-button.js';
import { formatDeadline } from '../../src/core/render.js';

export interface ScheduledItem {
  id: string;
  title: string;
  severity: string;
  scheduledFor?: string;
}

/**
 * Lists every scheduled announcement, soonest first — modelled on
 * DraftsList. This is the only place a scheduled send can be found and
 * cancelled from the admin index, and cancellation is the sole protection
 * against an unattended send whose circumstances changed after both
 * approvals were given.
 */
export default function ScheduledList({ items }: { items: ScheduledItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="drafts-list" aria-labelledby="scheduled-heading">
      <h2 id="scheduled-heading">Scheduled ({items.length})</h2>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            <div className="drafts-main">
              <span className="drafts-title">{item.title}</span>
              <span className="drafts-meta">
                {item.severity}
                {item.scheduledFor ? ` — due ${formatDeadline(item.scheduledFor)}` : ''}
              </span>
            </div>
            <span className="drafts-controls">
              <a className="pending-action" href={`/admin/review/${item.id}`}>
                Review
              </a>
              <CancelScheduleButton id={item.id} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

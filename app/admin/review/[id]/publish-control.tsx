'use client';
import { useState } from 'react';
// Deep import — see the comment on the same import in app/admin/compose-form.tsx
// (tsconfig.json's `paths` mapping for `next/navigation` breaks Turbopack's
// runtime resolution of useRouter, same failure mode as next/headers).
import { useRouter } from 'next/dist/client/components/navigation.js';
import {
  requestPublishAction,
  confirmPublishAction,
  withdrawPublishAction,
  rejectPublishAction,
  schedulePublishAction,
  confirmScheduleAction,
  cancelScheduleAction,
} from '../../actions.js';
import { formatDeadline } from '../../../../src/core/render.js';
import { utcInputToIso } from '../../../../src/core/datetime.js';
import type { Announcement } from '../../../../src/core/types.js';

export type PublishControlProps = {
  announcement: Announcement;
  viewerEmail?: string;
};

export default function PublishControl({ announcement, viewerEmail }: PublishControlProps) {
  const router = useRouter();
  // Which action is in flight. Every button is disabled while any action runs
  // (two publishes must not race), but only the clicked one shows the spinner
  // and its "…" label — three buttons all reading "Publishing…" / "Requesting…"
  // / "Scheduling…" at once told the publisher nothing.
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined);
  const pending = pendingKey !== undefined;
  const [error, setError] = useState<string | undefined>(undefined);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [scheduleInput, setScheduleInput] = useState('');
  const [cancelArmed, setCancelArmed] = useState(false);

  async function run(key: string, action: () => Promise<{ announcement?: Announcement; error?: string }>) {
    setPendingKey(key);
    setError(undefined);
    try {
      const res = await action();
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } finally {
      setPendingKey(undefined);
    }
  }

  if (announcement.status === 'published') {
    return (
      <div className="notice">
        <p>
          Published {announcement.publishedAt ? formatDeadline(announcement.publishedAt) : ''}
          {announcement.publishRequestedBy && announcement.publishConfirmedBy
            && announcement.publishRequestedBy !== announcement.publishConfirmedBy
            ? ` — requested by ${announcement.publishRequestedBy}, approved by ${announcement.publishConfirmedBy}`
            : announcement.publishConfirmedBy ? ` by ${announcement.publishConfirmedBy}` : ''}.
        </p>
      </div>
    );
  }

  if (announcement.status === 'discarded') {
    return (
      <div className="notice">
        <p>This draft was discarded. It cannot be published or edited.</p>
      </div>
    );
  }

  if (announcement.status === 'superseded') {
    return (
      <div className="notice">
        <p>This revision has been superseded.</p>
      </div>
    );
  }

  const isRequester = announcement.publishRequestedBy === viewerEmail;

  return (
    <div>
      {error && (
        <div className="notice">
          <p>Error: {error}</p>
        </div>
      )}

      {announcement.status === 'draft' && announcement.publishRejectedBy && (
        <div className="notice notice-reject">
          <p>
            <strong>Publication was rejected</strong> by {announcement.publishRejectedBy}:
            {' '}{announcement.publishRejectedReason}
          </p>
          <p className="muted">
            This announcement is a draft again, so it can be edited and requested again — including by
            the publisher who rejected it. Publishing it will still need a second publisher to confirm.
          </p>
          <p className="muted">
            <a className="pending-action" href={`/admin?from=edit:${announcement.id}`}>Edit this draft</a>
          </p>
        </div>
      )}

      {announcement.status === 'draft' && announcement.severity !== 'critical' && (
        <button
          type="button"
          disabled={pending}
          aria-busy={pendingKey === 'publish'}
          onClick={() => run('publish', () => requestPublishAction(announcement.id))}
        >
          {pendingKey === 'publish' && <span className="spinner" aria-hidden="true" />}
          {pendingKey === 'publish' ? 'Publishing…' : 'Publish now'}
        </button>
      )}

      {announcement.status === 'draft' && announcement.severity === 'critical' && (
        <button
          type="button"
          disabled={pending}
          aria-busy={pendingKey === 'request'}
          onClick={() => run('request', () => requestPublishAction(announcement.id))}
        >
          {pendingKey === 'request' && <span className="spinner" aria-hidden="true" />}
          {pendingKey === 'request' ? 'Requesting…' : 'Request publication'}
        </button>
      )}

      {announcement.status === 'draft' && (
        <div className="schedule-control">
          <label htmlFor="schedule-when">Schedule for (UTC)</label>
          {' '}
          <input
            id="schedule-when"
            type="datetime-local"
            value={scheduleInput}
            onChange={(e) => setScheduleInput(e.target.value)}
            disabled={pending}
          />
          {' '}
          <button
            type="button"
            disabled={pending || !scheduleInput}
            aria-busy={pendingKey === 'schedule'}
            onClick={() => {
              const iso = utcInputToIso(scheduleInput);
              if (!iso) {
                setError('scheduled time is not a valid date');
                return;
              }
              run('schedule', () => schedulePublishAction(announcement.id, iso));
            }}
          >
            {pendingKey === 'schedule' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'schedule' ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      )}

      {announcement.status === 'publish_requested' && !announcement.scheduledFor && isRequester && (
        <div>
          <button type="button" disabled>Waiting for confirmation</button>
          {' '}
          <button
            type="button"
            className="destructive"
            disabled={pending}
            aria-busy={pendingKey === 'withdraw'}
            onClick={() => run('withdraw', () => withdrawPublishAction(announcement.id))}
          >
            {pendingKey === 'withdraw' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'withdraw' ? 'Withdrawing…' : 'Withdraw request'}
          </button>
          <p className="muted">
            Waiting for a second publisher. You requested this
            {announcement.publishRequestedBy ? ` as ${announcement.publishRequestedBy}` : ''}.
          </p>
        </div>
      )}

      {announcement.status === 'publish_requested' && announcement.scheduledFor && isRequester && (
        <div>
          <button type="button" disabled>Waiting for confirmation</button>
          {' '}
          <button
            type="button"
            className="destructive"
            disabled={pending}
            aria-busy={pendingKey === 'withdraw'}
            onClick={() => run('withdraw', () => withdrawPublishAction(announcement.id))}
          >
            {pendingKey === 'withdraw' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'withdraw' ? 'Withdrawing…' : 'Withdraw request'}
          </button>
          <p className="muted">
            Waiting for a second publisher to confirm this schedule. You requested it
            {announcement.publishRequestedBy ? ` as ${announcement.publishRequestedBy}` : ''}, for{' '}
            {formatDeadline(announcement.scheduledFor)}.
          </p>
        </div>
      )}

      {announcement.status === 'publish_requested' && !announcement.scheduledFor && !isRequester && (
        <div>
          <p className="muted">
            Requested by {announcement.publishRequestedBy ?? 'another publisher'}. Critical announcements
            require a second publisher to confirm.
          </p>
          <button
            type="button"
            disabled={pending}
            aria-busy={pendingKey === 'confirm'}
            onClick={() => run('confirm', () => confirmPublishAction(announcement.id))}
          >
            {pendingKey === 'confirm' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'confirm' ? 'Confirming…' : 'Confirm and publish'}
          </button>
          {' '}
          {!showRejectForm && (
            <button
              type="button"
              className="destructive"
              disabled={pending}
              onClick={() => setShowRejectForm(true)}
            >
              Reject
            </button>
          )}
          {showRejectForm && (
            <div className="reject-form">
              <label htmlFor="reject-reason">Reason for rejection</label>
              <textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={pending}
                placeholder="Explain what needs to change before this can be requested again."
              />
              <div>
                <button
                  type="button"
                  className="destructive"
                  disabled={pending || rejectReason.trim().length === 0}
                  aria-busy={pendingKey === 'reject'}
                  onClick={() => run('reject', () => rejectPublishAction(announcement.id, rejectReason.trim()))}
                >
                  {pendingKey === 'reject' && <span className="spinner" aria-hidden="true" />}
                  {pendingKey === 'reject' ? 'Rejecting…' : 'Submit rejection'}
                </button>
                {' '}
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={() => {
                    setShowRejectForm(false);
                    setRejectReason('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {announcement.status === 'publish_requested' && announcement.scheduledFor && !isRequester && (
        <div>
          <p className="muted">
            Requested by {announcement.publishRequestedBy ?? 'another publisher'}, for{' '}
            {formatDeadline(announcement.scheduledFor)}. Critical announcements require a second publisher
            to confirm.
          </p>
          <button
            type="button"
            disabled={pending}
            aria-busy={pendingKey === 'confirm-schedule'}
            onClick={() => run('confirm-schedule', () => confirmScheduleAction(announcement.id))}
          >
            {pendingKey === 'confirm-schedule' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'confirm-schedule' ? 'Confirming…' : 'Confirm schedule'}
          </button>
          {' '}
          {!showRejectForm && (
            <button
              type="button"
              className="destructive"
              disabled={pending}
              onClick={() => setShowRejectForm(true)}
            >
              Reject
            </button>
          )}
          {showRejectForm && (
            <div className="reject-form">
              <label htmlFor="reject-reason">Reason for rejection</label>
              <textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={pending}
                placeholder="Explain what needs to change before this can be requested again."
              />
              <div>
                <button
                  type="button"
                  className="destructive"
                  disabled={pending || rejectReason.trim().length === 0}
                  aria-busy={pendingKey === 'reject'}
                  onClick={() => run('reject', () => rejectPublishAction(announcement.id, rejectReason.trim()))}
                >
                  {pendingKey === 'reject' && <span className="spinner" aria-hidden="true" />}
                  {pendingKey === 'reject' ? 'Rejecting…' : 'Submit rejection'}
                </button>
                {' '}
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={() => {
                    setShowRejectForm(false);
                    setRejectReason('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {announcement.status === 'scheduled' && (
        <div>
          <p className="muted">
            Scheduled to publish {announcement.scheduledFor ? formatDeadline(announcement.scheduledFor) : ''}.
          </p>
          <button
            type="button"
            className="destructive"
            disabled={pending}
            aria-busy={pendingKey === 'cancel-schedule'}
            onClick={() => {
              if (!cancelArmed) {
                setCancelArmed(true);
                return;
              }
              run('cancel-schedule', () => cancelScheduleAction(announcement.id));
            }}
          >
            {pendingKey === 'cancel-schedule' && <span className="spinner" aria-hidden="true" />}
            {pendingKey === 'cancel-schedule' ? 'Cancelling…' : cancelArmed ? 'Confirm cancel?' : 'Cancel'}
          </button>
          {cancelArmed && !pending && (
            <button
              type="button"
              className="secondary"
              onClick={() => setCancelArmed(false)}
            >
              Keep scheduled
            </button>
          )}
          <p className="muted">
            Cancelling returns this announcement to draft. Re-scheduling needs a fresh confirmation.
          </p>
        </div>
      )}
    </div>
  );
}

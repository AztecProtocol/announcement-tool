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
} from '../../actions.js';
import { formatDeadline } from '../../../../src/core/render.js';
import type { Announcement } from '../../../../src/core/types.js';

export type PublishControlProps = {
  announcement: Announcement;
  viewerEmail?: string;
};

export default function PublishControl({ announcement, viewerEmail }: PublishControlProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  async function run(action: () => Promise<{ announcement?: Announcement; error?: string }>) {
    setPending(true);
    setError(undefined);
    try {
      const res = await action();
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (announcement.status === 'published') {
    return (
      <div className="notice">
        <p>
          Published {announcement.publishedAt ? formatDeadline(announcement.publishedAt) : ''}
          {announcement.publishConfirmedBy ? ` by ${announcement.publishConfirmedBy}` : ''}.
        </p>
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
          <p className="muted">Edit the announcement, then request publication again.</p>
        </div>
      )}

      {announcement.status === 'draft' && announcement.severity !== 'critical' && (
        <button type="button" disabled={pending} onClick={() => run(() => requestPublishAction(announcement.id))}>
          {pending ? 'Publishing…' : 'Publish now'}
        </button>
      )}

      {announcement.status === 'draft' && announcement.severity === 'critical' && (
        <button type="button" disabled={pending} onClick={() => run(() => requestPublishAction(announcement.id))}>
          {pending ? 'Requesting…' : 'Request publication'}
        </button>
      )}

      {announcement.status === 'publish_requested' && isRequester && (
        <div>
          <button type="button" disabled>Waiting for confirmation</button>
          {' '}
          <button
            type="button"
            className="destructive"
            disabled={pending}
            onClick={() => run(() => withdrawPublishAction(announcement.id))}
          >
            {pending ? 'Withdrawing…' : 'Withdraw request'}
          </button>
          <p className="muted">
            Waiting for a second publisher. You requested this
            {announcement.publishRequestedBy ? ` as ${announcement.publishRequestedBy}` : ''}.
          </p>
        </div>
      )}

      {announcement.status === 'publish_requested' && !isRequester && (
        <div>
          <p className="muted">
            Requested by {announcement.publishRequestedBy ?? 'another publisher'}. Critical announcements
            require a second publisher to confirm.
          </p>
          <button type="button" disabled={pending} onClick={() => run(() => confirmPublishAction(announcement.id))}>
            {pending ? 'Confirming…' : 'Confirm and publish'}
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
                  onClick={() => run(() => rejectPublishAction(announcement.id, rejectReason.trim()))}
                >
                  {pending ? 'Rejecting…' : 'Submit rejection'}
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
    </div>
  );
}

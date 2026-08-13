'use client';
import { useState } from 'react';
// Deep import — see the comment on the same import in app/admin/compose-form.tsx
// (tsconfig.json's `paths` mapping for `next/navigation` breaks Turbopack's
// runtime resolution of useRouter, same failure mode as next/headers).
import { useRouter } from 'next/dist/client/components/navigation.js';
import { requestPublishAction, confirmPublishAction } from '../../actions.js';
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
        </div>
      )}
    </div>
  );
}

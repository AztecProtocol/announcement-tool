'use client';
import { useState } from 'react';
// Deep import — see the comment on the same import in
// app/admin/review/[id]/publish-control.tsx (tsconfig.json's `paths` mapping
// for `next/navigation` breaks Turbopack's runtime resolution of useRouter,
// same failure mode as next/headers).
import { useRouter } from 'next/dist/client/components/navigation.js';
import { cancelScheduleAction } from './actions.js';

/**
 * Cancel control for a single row in the scheduled list. Any publisher may
 * cancel, not only the one who scheduled it — approval happened before the
 * wait, so cancellation is the only way to stop an unattended send whose
 * circumstances changed. Two-stage like DiscardButton: cancelling is
 * consequential (it returns the announcement to draft and clears both
 * approvals, so re-scheduling needs a fresh confirmation), so the first
 * click only arms the button.
 */
export default function CancelScheduleButton({ id }: { id: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleClick() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const res = await cancelScheduleAction(id);
      if (res.error) {
        setError(res.error);
        setArmed(false);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="draft-discard">
      <button type="button" className="destructive" disabled={pending} onClick={handleClick}>
        {pending ? 'Cancelling…' : armed ? 'Confirm cancel?' : 'Cancel'}
      </button>
      {armed && !pending && (
        <button type="button" className="draft-discard-cancel" onClick={() => setArmed(false)}>
          Keep scheduled
        </button>
      )}
      {error && <span className="pending-error">{error}</span>}
    </span>
  );
}

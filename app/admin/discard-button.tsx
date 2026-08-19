'use client';
import { useState } from 'react';
// Deep import — see the comment on the same import in
// app/admin/review/[id]/publish-control.tsx (tsconfig.json's `paths` mapping
// for `next/navigation` breaks Turbopack's runtime resolution of useRouter,
// same failure mode as next/headers).
import { useRouter } from 'next/dist/client/components/navigation.js';
import { discardDraftAction } from './actions.js';

/**
 * Discard control for a single row in the drafts list. Two-stage rather than
 * a single click: discarding is destructive from the author's point of view
 * (the draft drops off every list they can reach, even though the row
 * survives in the database), so the first click only arms the button and the
 * second click actually discards. `window.confirm` was the other option
 * considered — this codebase uses it nowhere else, and a two-stage button is
 * testable and styleable in a way a native dialog is not.
 *
 * Split out from DraftsList (a server component), same as WithdrawButton is
 * split out from PendingQueue.
 */
export default function DiscardButton({ id }: { id: string }) {
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
      const res = await discardDraftAction(id);
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
        {pending ? 'Discarding…' : armed ? 'Confirm discard?' : 'Discard'}
      </button>
      {armed && !pending && (
        <button type="button" className="draft-discard-cancel" onClick={() => setArmed(false)}>
          Cancel
        </button>
      )}
      {error && <span className="pending-error">{error}</span>}
    </span>
  );
}

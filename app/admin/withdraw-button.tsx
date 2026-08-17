'use client';
import { useState } from 'react';
// Deep import — see the comment on the same import in
// app/admin/review/[id]/publish-control.tsx (tsconfig.json's `paths` mapping
// for `next/navigation` breaks Turbopack's runtime resolution of useRouter,
// same failure mode as next/headers).
import { useRouter } from 'next/dist/client/components/navigation.js';
import { withdrawPublishAction } from './actions.js';

/**
 * Withdraw control for a single row in the pending-confirmation queue.
 * Split out from PendingQueue (a server component) because calling a server
 * action from a button requires a client boundary — this keeps that boundary
 * as small as possible instead of converting the whole queue to a client
 * component.
 */
export default function WithdrawButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleClick() {
    setPending(true);
    setError(undefined);
    try {
      const res = await withdrawPublishAction(id);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="pending-withdraw">
      <button type="button" className="destructive" disabled={pending} onClick={handleClick}>
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </button>
      {error && <span className="pending-error">{error}</span>}
    </span>
  );
}

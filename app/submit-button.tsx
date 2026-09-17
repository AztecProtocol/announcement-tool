'use client';
import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The submit button for a form whose action runs on the server. useFormStatus
 * reports the enclosing <form>'s pending state, so this works inside forms
 * rendered by server components, which cannot hold state of their own. While
 * pending it is disabled (a second click does nothing) and shows the spinner.
 */
export default function SubmitButton({ children, pendingLabel, className }: {
  children: ReactNode; pendingLabel?: string; className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending && <span className="spinner" aria-hidden="true" />}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

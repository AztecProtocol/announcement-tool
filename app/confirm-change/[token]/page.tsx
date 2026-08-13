import { redirect } from 'next/navigation';
import { getDb } from '../../../src/web/db.js';
import { confirmFilterChange } from '../../../src/core/subscribe-flow.js';
import { isValidToken } from '../../../src/web/unsubscribe-html.js';

export const dynamic = 'force-dynamic';

// Confirmation must never happen on GET: mail scanners prefetch links and
// would auto-apply filter changes the owner never clicked. GET only ever
// renders a button; the actual confirmFilterChange() call happens inside the
// 'use server' action below, which only runs on a real form POST. Mirrors
// app/confirm/[token]/page.tsx.
export default async function ConfirmChangePage(
  { params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> },
) {
  const { token } = await params;
  const { done } = await searchParams;

  if (!isValidToken(token)) {
    return (
      <>
        <h1>Link not recognized</h1>
        <p>This confirmation link is invalid or was already used. You can <a href="/">subscribe again</a>.</p>
      </>
    );
  }

  if (done === '1') {
    return (
      <>
        <h1>Preferences updated</h1>
        <p>You will now receive Aztec release announcements matching your new preferences.</p>
        <p className="muted">Every email includes a link to change preferences or unsubscribe.</p>
      </>
    );
  }
  if (done === '0') {
    return (
      <>
        <h1>Link not recognized</h1>
        <p>This confirmation link is invalid or was already used. You can <a href="/">subscribe again</a>.</p>
      </>
    );
  }

  async function confirm(): Promise<void> {
    'use server';
    const ok = await confirmFilterChange(getDb(), token);
    redirect(`/confirm-change/${token}?done=${ok ? '1' : '0'}`);
  }

  return (
    <>
      <h1>Confirm your preference change</h1>
      <p>Click below to apply the change to your Aztec release announcement preferences.</p>
      <form action={confirm}>
        <button type="submit">Confirm change</button>
      </form>
    </>
  );
}

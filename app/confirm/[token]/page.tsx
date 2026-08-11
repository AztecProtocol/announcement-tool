import { redirect } from 'next/navigation';
import { getDb } from '../../../src/web/db.js';
import { confirmSubscription } from '../../../src/core/subscribe-flow.js';
import { isValidToken } from '../../../src/web/unsubscribe-html.js';

export const dynamic = 'force-dynamic';

// Confirmation must never happen on GET: mail scanners prefetch links and
// would auto-confirm subscriptions the owner never clicked. GET only ever
// renders a button; the actual confirmSubscription() call happens inside the
// 'use server' action below, which only runs on a real form POST.
export default async function ConfirmPage(
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
        <h1>Subscription confirmed</h1>
        <p>You will now receive Aztec release announcements matching your preferences.</p>
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
    const sub = await confirmSubscription(getDb(), token);
    redirect(`/confirm/${token}?done=${sub ? '1' : '0'}`);
  }

  return (
    <>
      <h1>Confirm your subscription</h1>
      <p>Click below to start receiving Aztec release announcements matching your preferences.</p>
      <form action={confirm}>
        <button type="submit">Confirm subscription</button>
      </form>
    </>
  );
}

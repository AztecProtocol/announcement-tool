import { getDb } from '../../../src/web/db.js';
import { confirmSubscription } from '../../../src/core/subscribe-flow.js';

export const dynamic = 'force-dynamic';

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const sub = await confirmSubscription(getDb(), token);
  if (!sub) {
    return (
      <>
        <h1>Link not recognized</h1>
        <p>This confirmation link is invalid or was already used. You can <a href="/">subscribe again</a>.</p>
      </>
    );
  }
  return (
    <>
      <h1>Subscription confirmed</h1>
      <p>You will now receive Aztec release announcements matching your preferences.</p>
      <p className="muted">Every email includes a link to change preferences or unsubscribe.</p>
    </>
  );
}

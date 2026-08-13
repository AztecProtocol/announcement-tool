'use client';

/**
 * Admin-scoped error boundary. Catches any unexpected throw under /admin so it
 * never falls back to a page that might render partial admin UI. Deliberately
 * generic — no error message, stack, or env state reaches the page.
 */
export default function AdminError() {
  return (
    <main>
      <h1>Something went wrong in admin</h1>
      <p className="muted">Reload the page. If this keeps happening, check the server logs.</p>
    </main>
  );
}

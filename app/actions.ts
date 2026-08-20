'use server';
import { redirect } from 'next/navigation';
// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/actions.ts.
import { headers } from 'next/dist/server/request/headers.js';
import { getDb } from '../src/web/db.js';
import { senderFromEnv } from '../src/adapters/esp.js';
import { startEmailSubscription } from '../src/core/subscribe-flow.js';
import { registerWebhook } from '../src/core/webhook-flow.js';
import { createRateLimiter } from '../src/core/rate-limit.js';
import type { AnnouncementType, Audience, Network, Severity } from '../src/core/types.js';

// Rate limiters for the two public write paths. Module-level state, not
// exports — a 'use server' module may only export async functions. Separate
// limiter per action so a subscribe flood does not also block webhook
// registration. In-memory, per-process — see src/core/rate-limit.ts for the
// multi-instance caveat.
const subscribeLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
const webhookLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });

/**
 * Best-effort requester key for rate limiting. `x-forwarded-for` is set by
 * the reverse proxy in front of this app, but it is still a client-supplied
 * HTTP header: a direct or malicious client can set or rotate it at will.
 * This raises the cost of casual, single-source abuse — it is NOT a defence
 * against a determined attacker who varies the header per request. Falls
 * back to a single shared key when the header is absent, so all such
 * requests share one bucket rather than bypassing the limit entirely.
 */
async function requesterKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function filtersFrom(formData: FormData) {
  const pick = (name: string): string[] => formData.getAll(name).map(String);
  const networks = pick('networks') as Network[];
  const types = pick('types') as AnnouncementType[];
  const severities = pick('severities') as Severity[];
  const audiences = pick('audiences') as Audience[];
  return {
    ...(networks.length ? { networks } : {}),
    ...(types.length ? { types } : {}),
    ...(severities.length ? { severities } : {}),
    ...(audiences.length ? { audiences } : {}),
  };
}

export async function subscribeEmail(formData: FormData): Promise<void> {
  // Keyed on the requester, never on the submitted email — a rate-limit
  // refusal must not become a side channel that distinguishes a known
  // address from an unknown one (see the no-leak comment below).
  if (!subscribeLimiter.check(await requesterKey())) redirect('/?error=rate');
  const email = String(formData.get('email') ?? '').trim();
  if (!email.includes('@')) redirect('/?error=email');
  await startEmailSubscription(getDb(), senderFromEnv(), { email, filters: filtersFrom(formData) });
  redirect('/subscribed'); // same page regardless of prior state — no subscription-existence leak
}

export async function subscribeWebhook(formData: FormData): Promise<{ secretOnce?: string; verified: boolean; error?: string }> {
  if (!webhookLimiter.check(await requesterKey())) {
    return { verified: false, error: 'Too many requests, please try again shortly.' };
  }
  const url = String(formData.get('url') ?? '').trim();
  return registerWebhook(getDb(), { url, filters: filtersFrom(formData) });
}

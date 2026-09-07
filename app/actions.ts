'use server';
import { redirect } from 'next/navigation';
// Deep import, not 'next/headers' — see the tsconfig "paths" comment: the public
// specifier does not resolve under NodeNext, and a paths mapping to the .d.ts
// makes the call compile to `(void 0)()` at runtime under Turbopack.
import { headers } from 'next/dist/server/request/headers.js';
import { getDb } from '../src/web/db.js';
import { consumeRateLimit, RATE_LIMITS } from '../src/core/rate-limit.js';
import { clientIpFromHeaders } from '../src/web/client-ip.js';
import { URL_NOT_ALLOWED } from '../src/core/safe-url.js';
import { senderFromEnv } from '../src/adapters/esp.js';
import { startEmailSubscription } from '../src/core/subscribe-flow.js';
import { registerWebhook } from '../src/core/webhook-flow.js';
import type { AnnouncementType, Audience, Network, Severity } from '../src/core/types.js';

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

// Longest address RFC 5321 permits. Bounds the rate-limit key and stops a
// megabyte of text reaching the database or the email sender.
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_WEBHOOK_URL_LENGTH = 2048;

export async function subscribeEmail(formData: FormData): Promise<void> {
  // Lowercased so that one address cannot buy extra attempts by varying case.
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) redirect('/?error=email');

  // Validate BEFORE consuming a limit, so malformed input cannot burn a real
  // subscriber's attempts.
  const sql = getDb();
  const ip = clientIpFromHeaders(await headers());
  const byIp = await consumeRateLimit(sql, `email:ip:${ip}`, RATE_LIMITS.emailPerIp);
  const byAddress = await consumeRateLimit(sql, `email:addr:${email}`, RATE_LIMITS.emailPerAddress);
  // One error for both limits: saying which one hit would tell a prober whether
  // an address has been submitted before.
  if (!byIp.allowed || !byAddress.allowed) redirect('/?error=rate');

  await startEmailSubscription(sql, senderFromEnv(), { email, filters: filtersFrom(formData) });
  redirect('/subscribed'); // same page regardless of prior state — no subscription-existence leak
}

export async function subscribeWebhook(formData: FormData): Promise<{ secretOnce?: string; verified: boolean; error?: string }> {
  const url = String(formData.get('url') ?? '').trim();
  // Refused with the same message as any other disallowed URL — the length
  // cap is not a distinct signal worth handing back.
  if (url.length > MAX_WEBHOOK_URL_LENGTH) return { verified: false, error: URL_NOT_ALLOWED };

  const sql = getDb();
  const ip = clientIpFromHeaders(await headers());
  const byIp = await consumeRateLimit(sql, `webhook:ip:${ip}`, RATE_LIMITS.webhookPerIp);
  if (!byIp.allowed) {
    return { verified: false, error: 'Too many webhook registrations from your network. Try again in an hour.' };
  }

  return registerWebhook(sql, { url, filters: filtersFrom(formData) });
}

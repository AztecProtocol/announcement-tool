'use server';
import { redirect } from 'next/navigation';
import { getDb } from '../src/web/db.js';
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

export async function subscribeEmail(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email.includes('@')) redirect('/?error=email');
  await startEmailSubscription(getDb(), senderFromEnv(), { email, filters: filtersFrom(formData) });
  redirect('/subscribed'); // same page regardless of prior state — no subscription-existence leak
}

export async function subscribeWebhook(formData: FormData): Promise<{ secretOnce?: string; verified: boolean; error?: string }> {
  const url = String(formData.get('url') ?? '').trim();
  return registerWebhook(getDb(), { url, filters: filtersFrom(formData) });
}

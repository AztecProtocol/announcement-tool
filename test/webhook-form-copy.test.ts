import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The registration panel's wording was approved by the product owner on
// 2026-09-15. This pins the sentences that tell an operator what to do and in
// which order; change the copy and the test together.
const src = ['../app/webhook-form.tsx', '../src/web/webhook-copy.ts']
  .map((p) => readFileSync(resolve(__dirname, p), 'utf8')).join('\n');

describe('webhook registration panel copy', () => {
  it.each([
    'Registered. Not active yet.',
    'Webhook secret — shown only once:',
    'Webhook page — keep this link, it is the only way back to this webhook:',
    'Do this now, in this order:',
    'Put the secret in your webhook configuration. Your endpoint uses it to check the',
    'Store the webhook page link somewhere safe. Anyone with the link can remove the webhook.',
    'When your endpoint has the secret, click',
    'The webhook becomes active only after a passed test.',
    'Send test event',
    'Test passed. The webhook is active.',
    'Test failed.',
    'This URL is already registered. If it is yours, open its webhook page and use Remove webhook, then register again.',
  ])('contains %j', (s) => {
    expect(src).toContain(s);
  });
});

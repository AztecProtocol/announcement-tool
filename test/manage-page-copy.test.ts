import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../app/manage/[token]/page.tsx'), 'utf8');

describe('manage page copy for a webhook', () => {
  it.each([
    'Not active',
    'no passed test yet',
    'Send test event',
    'Remove webhook',
    'The secret was shown once at registration. If you lost it, remove this webhook and register the URL again to get a new one.',
    'Test passed. The webhook is active.',
    'Test failed.',
  ])('contains %j', (s) => {
    expect(src).toContain(s);
  });
});

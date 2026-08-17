import { describe, it, expect } from 'vitest';
import { inputFromForm } from '../app/admin/input-from-form.js';

/** Minimal valid form fields inputFromForm needs before we add the field under test. */
function baseForm(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('type', 'upgrade');
  fd.append('networks', 'mainnet');
  fd.append('audiences', 'operators');
  fd.set('severity', 'recommended');
  fd.set('title', 'Upgrade now');
  fd.set('bodyMd', 'Body text.');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe('inputFromForm: slug', () => {
  it('rejects a punctuation-only slug instead of silently substituting a generated one', () => {
    const fd = baseForm({ slug: '!!!' });
    expect(() => inputFromForm(fd)).toThrow();
  });

  it('rejection message is a real slugError message, not a generic one', () => {
    // '!!!' has no alphanumerics, so normalizeSlug reduces it to '' and
    // slugError reports the resulting emptiness — a true, specific reason,
    // not a placeholder string.
    const fd = baseForm({ slug: '!!!' });
    expect(() => inputFromForm(fd)).toThrow(/required/i);
  });

  it('passes a valid slug through unchanged', () => {
    const fd = baseForm({ slug: 'v5-2-0-upgrade' });
    const input = inputFromForm(fd);
    expect(input.slug).toBe('v5-2-0-upgrade');
  });

  it('an empty slug field falls back to no slug (generation happens downstream) without throwing', () => {
    const fd = baseForm();
    const input = inputFromForm(fd);
    expect(() => inputFromForm(fd)).not.toThrow();
    expect(input.slug).toBeUndefined();
  });
});

describe('inputFromForm: title newline normalisation', () => {
  it('strips the CRLF so the title carries no embedded newline', () => {
    const fd = baseForm({ title: 'Upgrade\r\nnow' });
    const input = inputFromForm(fd);
    // normalizeNewlines converts \r\n -> \n and trims, but does not join lines
    // with a space — so a title with an embedded line break becomes a
    // multi-line LF string here, exactly like bodyMd. The bug this guards is a
    // *surviving \r*, not the LF itself.
    expect(input.title).toBe('Upgrade\nnow');
    expect(input.title).not.toContain('\r');
  });

  it('normalizeNewlines is applied to title exactly as it is to bodyMd', () => {
    const fd = baseForm({ title: 'Line one\r\nLine two', bodyMd: 'Line one\r\nLine two' });
    const input = inputFromForm(fd);
    expect(input.title).toBe(input.bodyMd);
  });
});

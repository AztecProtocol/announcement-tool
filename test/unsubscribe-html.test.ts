import { describe, it, expect } from 'vitest';
import {
  isValidToken, escapeHtml, renderConfirmPage, renderInvalidTokenPage, isOneClickBody,
} from '../src/web/unsubscribe-html.js';

describe('isValidToken', () => {
  it('accepts a 32-char lowercase hex token', () => {
    expect(isValidToken('a'.repeat(32))).toBe(true);
    expect(isValidToken('0123456789abcdef0123456789abcdef')).toBe(true);
  });
  it('rejects malformed / malicious tokens', () => {
    expect(isValidToken('')).toBe(false);
    expect(isValidToken('too-short')).toBe(false);
    expect(isValidToken('A'.repeat(32))).toBe(false); // uppercase not allowed
    expect(isValidToken('"><script>alert(1)</script>')).toBe(false);
    expect(isValidToken('a'.repeat(31) + 'g')).toBe(false); // non-hex char
    expect(isValidToken('a'.repeat(33))).toBe(false); // too long
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert('x')&"y"</script>`))
      .toBe('&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;');
  });
});

describe('renderConfirmPage', () => {
  const maliciousToken = `"><script>alert(document.cookie)</script>`;

  it('never echoes an unescaped malicious token into the output', () => {
    const html = renderConfirmPage(maliciousToken);
    expect(html).not.toContain('<script>alert(document.cookie)</script>');
    expect(html).not.toContain('"><script>');
  });

  it('places a valid token only in the two expected attribute positions', () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const html = renderConfirmPage(token);
    expect(html).toContain(`action="/u/${token}"`);
    expect(html).toContain(`href="/manage/${token}"`);
    // exactly two occurrences of the token in the whole document
    expect(html.split(token)).toHaveLength(3);
  });
});

describe('renderInvalidTokenPage', () => {
  it('is a static generic page with no input to echo', () => {
    const html = renderInvalidTokenPage();
    expect(html).toContain('Link not recognized');
    expect(html).not.toContain('undefined');
  });
});

describe('isOneClickBody', () => {
  it('recognizes the RFC 8058 one-click body', () => {
    expect(isOneClickBody('List-Unsubscribe=One-Click')).toBe(true);
    expect(isOneClickBody('  List-Unsubscribe=One-Click  \n')).toBe(true);
  });
  it('rejects anything else, including a human form body', () => {
    expect(isOneClickBody('confirm=1')).toBe(false);
    expect(isOneClickBody('')).toBe(false);
  });
});

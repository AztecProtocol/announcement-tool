import { describe, expect, it } from 'vitest';
import { buildCsp, cspHeaderName, generateNonce, REPORT_PATH } from '../src/web/csp.js';

describe('generateNonce', () => {
  it('is base64, at least 22 characters, and different each call', () => {
    const a = generateNonce(), b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(a).not.toBe(b);
  });
});

describe('buildCsp', () => {
  const csp = buildCsp('abc123');
  const directive = (name: string) => csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ') || s === name);

  it('restricts scripts to self plus the nonce, with strict-dynamic', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });
  it('does not allow unsafe-inline for scripts anywhere', () => {
    expect(directive('script-src')).not.toContain('unsafe-inline');
    expect(directive('default-src')).toBe("default-src 'self'");
  });
  it('keeps inline styles, because the rendered HTML uses style attributes', () => {
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });
  it('carries the framing, object, base-uri and form-action rules the old static policy had', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
  });
  it('reports to the local endpoint', () => {
    expect(directive('report-uri')).toBe(`report-uri ${REPORT_PATH}`);
  });
  it('is a single line with no double spaces', () => {
    expect(csp).not.toMatch(/\n|\s{2,}/);
  });
});

describe('cspHeaderName', () => {
  it('enforces only on the exact string "enforce"', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
  });
  it('is report-only for anything else, including unset and near-misses', () => {
    for (const v of [undefined, '', 'Enforce', 'true', '1', 'report-only', ' enforce']) {
      expect(cspHeaderName(v)).toBe('Content-Security-Policy-Report-Only');
    }
  });
});

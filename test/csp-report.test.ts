import { describe, expect, it } from 'vitest';
import { summarizeCspReport } from '../src/web/csp-report.js';

describe('summarizeCspReport', () => {
  it('extracts the fields an operator needs from the legacy report-uri shape', () => {
    const line = summarizeCspReport({ 'csp-report': {
      'document-uri': 'https://announce.aztec.network/admin',
      'violated-directive': 'script-src',
      'blocked-uri': 'inline',
      'line-number': 12,
    } });
    expect(line).toContain('script-src');
    expect(line).toContain('/admin');
    expect(line).toContain('inline');
  });
  it('accepts the Reporting API array shape', () => {
    const line = summarizeCspReport([{ type: 'csp-violation', body: {
      documentURL: 'https://announce.aztec.network/', effectiveDirective: 'script-src-elem', blockedURL: 'inline',
    } }]);
    expect(line).toContain('script-src-elem');
  });
  it('never exceeds 1000 characters and never throws on junk', () => {
    expect(summarizeCspReport('x'.repeat(50_000)).length).toBeLessThanOrEqual(1000);
    expect(() => summarizeCspReport(null)).not.toThrow();
    expect(() => summarizeCspReport({ a: { b: { c: 1 } } })).not.toThrow();
  });
  it('strips query strings from document URLs so tokens never reach the log', () => {
    const line = summarizeCspReport({ 'csp-report': { 'document-uri': 'https://x/confirm/abc?token=SECRET', 'violated-directive': 'script-src' } });
    expect(line).not.toContain('SECRET');
  });
});

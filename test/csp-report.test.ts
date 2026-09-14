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
  it('strips query strings and fragments from blocked-uri and source-file, legacy shape', () => {
    const line = summarizeCspReport({ 'csp-report': {
      'document-uri': 'https://x/',
      'violated-directive': 'script-src',
      'blocked-uri': 'https://evil.example/x?token=SECRETTOKEN#fragtoken',
      'source-file': 'https://x/confirm/abc?token=SOURCETOKEN#sfrag',
    } });
    expect(line).not.toContain('SECRETTOKEN');
    expect(line).not.toContain('fragtoken');
    expect(line).not.toContain('SOURCETOKEN');
    expect(line).not.toContain('sfrag');
  });
  it('strips query strings and fragments from blockedURL and sourceFile, Reporting API shape', () => {
    const line = summarizeCspReport([{ type: 'csp-violation', body: {
      documentURL: 'https://x/',
      effectiveDirective: 'script-src',
      blockedURL: 'https://evil.example/x?token=SECRETTOKEN#fragtoken',
      sourceFile: 'https://x/confirm/abc?token=SOURCETOKEN#sfrag',
    } }]);
    expect(line).not.toContain('SECRETTOKEN');
    expect(line).not.toContain('fragtoken');
    expect(line).not.toContain('SOURCETOKEN');
    expect(line).not.toContain('sfrag');
  });
  it('strips fragments from document URLs too', () => {
    const line = summarizeCspReport({ 'csp-report': { 'document-uri': 'https://x/page?token=QTOKEN#FRAGTOKEN', 'violated-directive': 'script-src' } });
    expect(line).not.toContain('QTOKEN');
    expect(line).not.toContain('FRAGTOKEN');
  });
  it('collapses control characters so a newline in a field cannot forge a second log line', () => {
    const line = summarizeCspReport({ 'csp-report': {
      'document-uri': 'https://x/evil\n2026-09-14 FAKE LINE\r',
      'violated-directive': 'script-src',
    } });
    expect(line).not.toMatch(/[\n\r]/);
  });
  it('collapses control characters in the Reporting API shape too', () => {
    const line = summarizeCspReport([{ type: 'csp-violation', body: {
      documentURL: 'https://x/evil\n2026-09-14 FAKE LINE\r',
      effectiveDirective: 'script-src',
    } }]);
    expect(line).not.toMatch(/[\n\r]/);
  });
  it('replaces the DEL control character (U+007F) too, not just the C0 range', () => {
    const del = String.fromCharCode(0x7f);
    const line = summarizeCspReport({ 'csp-report': { 'document-uri': `https://x/evil${del}end`, 'violated-directive': 'script-src' } });
    expect(line).not.toContain(del);
  });
});

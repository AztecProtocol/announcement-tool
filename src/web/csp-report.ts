/**
 * A bounded, one-line summary of a browser CSP violation report, for the
 * server log.
 *
 * Browsers send two different report shapes depending on how they were
 * asked: the legacy `report-uri` shape wraps everything in a `csp-report`
 * object with hyphenated keys; the newer Reporting API (`report-to`) posts
 * an array of `{ type, body }` entries with camelCase keys. This function
 * accepts either.
 *
 * The input is untrusted — it is whatever a browser (or anyone who can POST
 * to the report endpoint) sends — so every access is defensive and the whole
 * thing is wrapped in try/catch. Nothing here can leak a secret: the only
 * fields pulled out are a CSP directive name, a blocked-URL/source string, a
 * line number, and a document URL with its query string stripped before use
 * (tokens are commonly carried as query parameters, e.g. an unsubscribe or
 * confirm link).
 */
export function summarizeCspReport(body: unknown): string {
  try {
    const report = normalizeReport(body);
    const directive = report.directive ?? 'unknown';
    const blocked = report.blocked ?? 'unknown';
    const document = stripQuery(report.document);
    const source = report.source ?? 'unknown';
    const line = report.line ?? 'unknown';
    const line_ = `csp-report directive=${directive} blocked=${blocked} document=${document} source=${source}:${line}`;
    return line_.slice(0, 1000);
  } catch {
    return 'csp-report unparseable';
  }
}

interface NormalizedReport {
  directive?: string;
  blocked?: string;
  document?: string;
  source?: string;
  line?: string | number;
}

function normalizeReport(body: unknown): NormalizedReport {
  // Reporting API shape: an array of { type, body }.
  if (Array.isArray(body)) {
    const first = body[0];
    const inner = isRecord(first) && isRecord(first.body) ? first.body : {};
    return {
      directive: str(inner.effectiveDirective) ?? str(inner.violatedDirective),
      blocked: str(inner.blockedURL),
      document: str(inner.documentURL),
      source: str(inner.sourceFile),
      line: numOrStr(inner.lineNumber),
    };
  }

  // Legacy report-uri shape: { "csp-report": {...} }.
  if (isRecord(body) && isRecord(body['csp-report'])) {
    const inner = body['csp-report'];
    return {
      directive: str(inner['violated-directive']) ?? str(inner['effective-directive']),
      blocked: str(inner['blocked-uri']),
      document: str(inner['document-uri']),
      source: str(inner['source-file']),
      line: numOrStr(inner['line-number']),
    };
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numOrStr(value: unknown): string | number | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

function stripQuery(url: string | undefined): string {
  if (!url) return 'unknown';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

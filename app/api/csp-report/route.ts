import { headers } from 'next/dist/server/request/headers.js';
import { getDb } from '../../../src/web/db.js';
import { consumeRateLimit, RATE_LIMITS } from '../../../src/core/rate-limit.js';
import { clientIpFromHeaders } from '../../../src/web/client-ip.js';
import { shouldAcceptCspReport, summarizeCspReport } from '../../../src/web/csp-report.js';

export const dynamic = 'force-dynamic';

/**
 * Receives Content-Security-Policy violation reports from browsers and writes
 * one bounded line per report to the server log, where an operator reads them
 * during the report-only period. No storage, no forwarding. The summariser
 * strips query strings and truncates, so nothing a page URL might carry (a
 * confirmation token, say) reaches the log.
 *
 * This route is public and unauthenticated, so it is rate-limited the same
 * way as every other public write path in this app (see app/actions.ts):
 * per-IP, through consumeRateLimit. A refused request still gets 204 — a
 * browser never reads the response body of a report-uri POST, and a 429
 * would itself be noise — but nothing is logged for it.
 *
 * The body is also bounded on size before it is read: a declared
 * content-length over 16 KB is refused without ever calling request.text().
 * The 8 KB slice below is the second line of defence for a request with no
 * (or an untrustworthy) content-length, e.g. a chunked body — it bounds what
 * is logged, not what is read, for that case.
 *
 * This route is excluded from the middleware matcher, so it neither receives a
 * policy header of its own nor touches the admin identity path.
 */
export async function POST(request: Request): Promise<Response> {
  const rawContentLength = request.headers.get('content-length');
  const contentLength = rawContentLength === null ? undefined : Number(rawContentLength);

  let limited = false;
  try {
    const sql = getDb();
    const ip = clientIpFromHeaders(await headers());
    const result = await consumeRateLimit(sql, `csp:ip:${ip}`, RATE_LIMITS.cspReportPerIp);
    limited = !result.allowed;
  } catch {
    // The limiter is unreachable (e.g. the database is down). Availability of
    // the CSP log matters more than the throttle here, so fall through and
    // log the report anyway rather than dropping it.
    limited = false;
  }

  if (!shouldAcceptCspReport({ contentLength: Number.isFinite(contentLength) ? contentLength : undefined, limited })) {
    return new Response(null, { status: 204 });
  }

  const text = (await request.text()).slice(0, 8_192);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* the summariser handles a non-JSON body */
  }
  console.warn(summarizeCspReport(body));
  return new Response(null, { status: 204 });
}

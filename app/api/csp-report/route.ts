import { summarizeCspReport } from '../../../src/web/csp-report.js';

export const dynamic = 'force-dynamic';

/**
 * Receives Content-Security-Policy violation reports from browsers and writes
 * one bounded line per report to the server log, where an operator reads them
 * during the report-only period. No storage, no forwarding. The body is capped
 * before parsing, and the summariser strips query strings and truncates, so
 * nothing a page URL might carry (a confirmation token, say) reaches the log.
 *
 * This route is excluded from the middleware matcher, so it neither receives a
 * policy header of its own nor touches the admin identity path.
 */
export async function POST(request: Request): Promise<Response> {
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

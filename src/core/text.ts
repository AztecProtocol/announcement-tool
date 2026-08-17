/**
 * Normalise submitted line endings to LF, and trim surrounding whitespace.
 *
 * Browsers submit textarea values with CRLF line breaks regardless of what the
 * author typed — the HTML form-submission spec requires that normalisation.
 * Every line-oriented rule downstream matches on \n: heading detection in
 * src/core/render.ts, the email HTML paragraph split (/\n{2,}/), and the
 * preview parser in app/admin/preview-render.ts. A surviving \r defeats all of
 * them at once — headings render as literal "## text" on every channel, and the
 * email body collapses into a single paragraph because \r\n\r\n never matches
 * the paragraph split.
 *
 * Normalising once at the input boundary keeps that rule in one place, rather
 * than requiring every present and future pattern to remember \r.
 */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim();
}

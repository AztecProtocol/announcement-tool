/**
 * Detects channel-mention syntax in an announcement body.
 *
 * The body is shared by every channel, but only Discord resolves a mention into
 * a real ping — everywhere else it is literal text a reader sees and cannot act
 * on. Mentions therefore belong in the Discord-only channel prefix
 * (channel_settings.config.prefix), not in the body. This detector drives an
 * authoring warning, not a block: the author may have a reason.
 */

// (?<![\w.@\-/]) keeps ops@everyone.example.com and similar from matching: it
// requires the character before '@' to not be a word char, dot, '@', or
// hyphen, so the '@' in an email's domain (preceded by a letter) is rejected.
// The '/' is excluded for the same reason: a URL path segment like
// example.com/@everyone/status is ordinary announcement content, not a
// mention, and would otherwise trip the same false-positive class as an
// email address — do not drop it as a "simplification".
// \b after the alternation keeps @everyonesomething / @hereafter from
// matching, since \b requires a non-word character (or end of string) to
// follow "everyone"/"here".
//
// app/admin/preview-render.ts's parseMentions uses a looser pattern with
// neither the lookbehind nor the \b guard. That is intentional, not drift:
// this regex scans the announcement body (free text that can contain emails
// and URLs, so the false-positive guards matter), while parseMentions scans
// only the Discord channel_settings prefix (operator-authored config, not
// free text, so the guards would be dead weight there). Do not merge the two.
const MENTION_RE = /(?<![\w.@\-/])@(?:everyone|here)\b|<@[&!]?\d+>/g;

export function findMentions(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
}

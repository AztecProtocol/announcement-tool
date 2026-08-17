/**
 * Detects channel-mention syntax in an announcement body.
 *
 * The body is shared by every channel, but only Discord resolves a mention into
 * a real ping — everywhere else it is literal text a reader sees and cannot act
 * on. Mentions therefore belong in the Discord-only channel prefix
 * (channel_settings.config.prefix), not in the body. This detector drives an
 * authoring warning, not a block: the author may have a reason.
 */

// (?<![\w.@-]) keeps ops@everyone.example.com and similar from matching: it
// requires the character before '@' to not be a word char, dot, '@', or
// hyphen, so the '@' in an email's domain (preceded by a letter) is rejected.
// \b after the alternation keeps @everyonesomething / @hereafter from
// matching, since \b requires a non-word character (or end of string) to
// follow "everyone"/"here".
const MENTION_RE = /(?<![\w.@-])@(?:everyone|here)\b|<@[&!]?\d+>/g;

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

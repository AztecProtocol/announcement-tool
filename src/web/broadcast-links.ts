/**
 * The public "Broadcast channels" list on the subscribe page.
 *
 * Each channel appears only when its URL is configured, so a deployment that
 * runs without Signal, or before the real Discord and Telegram handles exist,
 * shows no dead link. The variables are public by nature (they are printed
 * on a public page), which is why they carry the PUBLIC_ prefix.
 *
 * Only http(s) URLs are accepted: the values are rendered into an href, and
 * a configuration mistake must not become a javascript: link.
 */
export interface BroadcastLink {
  label: 'Discord' | 'Telegram' | 'Signal';
  url: string;
}

const CHANNELS: Array<{ label: BroadcastLink['label']; variable: string }> = [
  { label: 'Discord', variable: 'PUBLIC_DISCORD_URL' },
  { label: 'Telegram', variable: 'PUBLIC_TELEGRAM_URL' },
  { label: 'Signal', variable: 'PUBLIC_SIGNAL_URL' },
];

export function broadcastLinks(env: Record<string, string | undefined>): BroadcastLink[] {
  const links: BroadcastLink[] = [];
  for (const { label, variable } of CHANNELS) {
    const url = env[variable]?.trim();
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    links.push({ label, url });
  }
  return links;
}

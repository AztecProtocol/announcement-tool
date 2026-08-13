import type { Sql } from 'postgres';
import type { Announcement, AnnouncementInput, DeliveryKind } from './types.js';
import { renderPlain, renderMarkdown, renderTelegramHtml, renderEmail } from './render.js';
import { rowToSetting, broadcastTargetsFor } from './outbox.js';
import { makeSlug } from './ids.js';

export interface PreviewSet {
  discord: { target: string; content: string }[];
  telegram: string;
  signal: string;
  email: { subject: string; text: string };
  webhook: string;
}

/** Build a synthetic, never-persisted Announcement from the in-progress form input,
 * so every channel can be rendered through the exact same functions the adapters use. */
function toPreviewAnnouncement(input: AnnouncementInput): Announcement {
  const now = new Date();
  return {
    ...input,
    id: 'ann_preview',
    revision: 1,
    slug: makeSlug(now, input.type, input.title || 'untitled'),
    status: 'published',
    createdBy: 'preview',
    publishedAt: now.toISOString(),
  };
}

export async function previewAnnouncement(
  sql: Sql, input: AnnouncementInput, kind: DeliveryKind = 'publish',
): Promise<PreviewSet> {
  const a = toPreviewAnnouncement(input);

  const rows = await sql`select * from channel_settings where channel = 'discord'`;
  const settings = rows.map(rowToSetting);
  const targets = broadcastTargetsFor(a, settings);
  const discord = targets.map(t => {
    const cfg = settings.find(s => s.key === t.target)!.config;
    const prefix = (cfg.prefix as string | undefined)?.trim();
    const content = prefix ? `${prefix}\n${renderMarkdown(a, kind)}` : renderMarkdown(a, kind);
    return { target: t.target, content };
  });

  const { subject, text } = renderEmail(a, kind);

  // Mirrors the payload shape webhook.ts sends, field by field.
  const webhookPayload = {
    event_id: `${a.id}.${a.revision}.${kind}`,
    kind,
    announcement: {
      id: a.id, revision: a.revision, slug: a.slug, type: a.type,
      networks: a.networks, audiences: a.audiences, severity: a.severity,
      title: a.title, body_md: a.bodyMd, actions_required: a.actionsRequired,
      links: a.links, published_at: a.publishedAt ?? null, expires_at: a.expiresAt ?? null,
    },
  };

  return {
    discord,
    telegram: renderTelegramHtml(a, kind),
    signal: renderPlain(a, kind),
    email: { subject, text },
    webhook: JSON.stringify(webhookPayload, null, 2),
  };
}

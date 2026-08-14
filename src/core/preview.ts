import { ZodError } from 'zod';
import type { Sql } from 'postgres';
import type { Announcement, AnnouncementInput, DeliveryKind } from './types.js';
import { renderPlain, renderMarkdown, renderTelegramHtml, renderEmail } from './render.js';
import { rowToSetting, broadcastTargetsFor } from './outbox.js';
import { makeSlug } from './ids.js';
import { validateAnnouncement } from './validate.js';

export interface PreviewSet {
  // Set only when the input fails validateAnnouncement (e.g. a javascript:
  // link) — every other field below is omitted in that case, so the caller
  // shows the validation message instead of a rendered preview. Keeps the
  // save-time rejection from being the first time an author sees it.
  error?: string;
  // Non-blocking notices from validateAnnouncement (e.g. the GitHub-release
  // reminder) that don't prevent a preview from rendering.
  warnings?: string[];
  discord?: { target: string; content: string; prefix?: string }[];
  // undefined when no telegram/signal channel_settings row matches this
  // announcement's network and type — mirrors the discord array's filtering
  // via broadcastTargetsFor so the preview never shows a channel that
  // countFanoutTargets would not actually deliver to.
  telegram?: string;
  signal?: string;
  email?: { subject: string; text: string; html: string };
  webhook?: string;
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
  let warnings: string[];
  try {
    ({ warnings } = validateAnnouncement(input));
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues.map(i => i.message).join('; ') };
    throw err;
  }

  const a = toPreviewAnnouncement(input);

  const rows = await sql`select * from channel_settings`;
  const settings = rows.map(rowToSetting);
  const targets = broadcastTargetsFor(a, settings);

  const discordTargets = targets.filter(t => t.channel === 'discord');
  const discord = discordTargets.map(t => {
    const cfg = settings.find(s => s.key === t.target)!.config;
    const prefix = (cfg.prefix as string | undefined)?.trim();
    const content = prefix ? `${prefix}\n${renderMarkdown(a, kind)}` : renderMarkdown(a, kind);
    return { target: t.target, content, ...(prefix ? { prefix } : {}) };
  });

  const telegram = targets.some(t => t.channel === 'telegram') ? renderTelegramHtml(a, kind) : undefined;
  const signal = targets.some(t => t.channel === 'signal') ? renderPlain(a, kind) : undefined;

  const { subject, text, html } = renderEmail(a, kind);

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
    ...(warnings.length > 0 ? { warnings } : {}),
    discord,
    telegram,
    signal,
    email: { subject, text, html },
    webhook: JSON.stringify(webhookPayload, null, 2),
  };
}

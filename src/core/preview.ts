import { ZodError } from 'zod';
import type { Sql } from 'postgres';
import type { Announcement, AnnouncementInput, DeliveryKind, DiscordRole } from './types.js';
import { renderPlain, renderMarkdown, renderTelegramHtml, renderEmail } from './render.js';
import { rowToSetting, broadcastTargetsFor } from './outbox.js';
import { makeSlug } from './ids.js';
import { validateAnnouncement } from './validate.js';
import { composeMentionLine, parseDiscordRoles } from './discord-mentions.js';

export interface PreviewSet {
  // Set only when the input fails validateAnnouncement (e.g. a javascript:
  // link) — every other field below is omitted in that case, so the caller
  // shows the validation message instead of a rendered preview. Keeps the
  // save-time rejection from being the first time an author sees it.
  error?: string;
  // Non-blocking notices from validateAnnouncement (e.g. the GitHub-release
  // reminder) that don't prevent a preview from rendering.
  warnings?: string[];
  discord?: { target: string; content: string; prefix?: string; roles: DiscordRole[] }[];
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
    slug: input.slug || makeSlug(now, input.type, input.title || 'untitled'),
    status: 'published',
    createdBy: 'preview',
    publishedAt: now.toISOString(),
  };
}

/**
 * Renders one already-built Announcement to every channel. Shared by
 * previewAnnouncement (which synthesizes its subject from unsaved form input)
 * and previewStored (which passes a real row through untouched).
 *
 * `warnings` is threaded in rather than computed here because the two callers
 * obtain it differently: previewAnnouncement must catch a ZodError and return
 * it as `error`, while previewStored lets it throw.
 */
async function renderPreviewSet(
  sql: Sql, a: Announcement, kind: DeliveryKind, warnings: string[],
): Promise<PreviewSet> {
  const rows = await sql`select * from channel_settings`;
  const settings = rows.map(rowToSetting);
  const targets = broadcastTargetsFor(a, settings);

  const discordTargets = targets.filter(t => t.channel === 'discord');
  const discord = discordTargets.map(t => {
    const cfg = settings.find(s => s.key === t.target)!.config;
    const prefix = composeMentionLine(cfg, a.mentionRoleIds);
    // Byte-identical to src/adapters/discord.ts — see the comment there.
    const content = prefix ? `${prefix}\n\n${renderMarkdown(a, kind)}` : renderMarkdown(a, kind);
    return { target: t.target, content, ...(prefix ? { prefix } : {}), roles: parseDiscordRoles(cfg) };
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
      links: a.links, published_at: a.publishedAt ?? null,
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

  return renderPreviewSet(sql, toPreviewAnnouncement(input), kind, warnings);
}

/**
 * Previews an announcement that is already in the database, for the review
 * page. Unlike previewAnnouncement it does NOT re-derive identity: the stored
 * id, revision and slug go through untouched, so the webhook event_id and the
 * canonical link shown here are the ones that will actually be sent.
 *
 * `published_at` is the single field this preview cannot know — confirmPublish
 * sets it with `now()` inside the publishing transaction — so it renders as
 * null. The review page states that; do not substitute a plausible timestamp.
 *
 * A ZodError is deliberately NOT caught. Stored rows were validated when they
 * were saved, so a failure here is a real fault a reviewer must see, not an
 * empty preview pane.
 */
export async function previewStored(
  sql: Sql, a: Announcement, kind: DeliveryKind = 'publish',
): Promise<PreviewSet> {
  const { warnings } = validateAnnouncement(a);
  return renderPreviewSet(sql, a, kind, warnings);
}

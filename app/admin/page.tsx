// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/layout.tsx (tsconfig.json `paths` breaks Turbopack's dev resolver
// for that specifier).
import { headers } from 'next/dist/server/request/headers.js';
import ComposeForm from './compose-form.js';
import PendingQueue from './pending-queue.js';
import { getDb } from '../../src/web/db.js';
import { listTemplates, templateFromAnnouncement } from '../../src/core/templates.js';
import { getLatest } from '../../src/core/announcements.js';
import { resolveIdentity } from '../../src/core/identity.js';
import { listPublished, listAwaitingConfirmation } from '../../src/core/queries.js';
import { rowToSetting } from '../../src/core/outbox.js';
import { parseDiscordRoles } from '../../src/core/discord-mentions.js';
import type { AnnouncementInput, DiscordRole } from '../../src/core/types.js';

export const metadata = {
  title: 'Compose — Admin',
};

export const dynamic = 'force-dynamic';

/** Parses `?from=template:<id>` / `?from=announcement:<id>` into a kind + id, or undefined. */
function parseFrom(from: string | undefined): { kind: 'template' | 'announcement'; id: string } | undefined {
  if (!from) return undefined;
  const [kind, ...rest] = from.split(':');
  const id = rest.join(':');
  if (!id) return undefined;
  if (kind === 'template' || kind === 'announcement') return { kind, id };
  return undefined;
}

/**
 * The union of named roles across every Discord destination, deduplicated by
 * id. If two destinations give the same id different names, the first one
 * wins — that is a config error on the operator's part, not something the
 * form should try to reconcile.
 */
function distinctDiscordRoles(settings: { channel: string; config: Record<string, unknown> }[]): DiscordRole[] {
  const byId = new Map<string, DiscordRole>();
  for (const s of settings) {
    if (s.channel !== 'discord') continue;
    for (const r of parseDiscordRoles(s.config)) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  return [...byId.values()];
}

export default async function AdminComposePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const db = getDb();
  const identity = resolveIdentity(await headers());

  const [templates, recentAnnouncements, pending, channelSettingRows] = await Promise.all([
    listTemplates(db),
    listPublished(db, 20),
    listAwaitingConfirmation(db),
    db`select * from channel_settings`,
  ]);
  const discordRoles = distinctDiscordRoles(channelSettingRows.map(rowToSetting));

  let prefill: AnnouncementInput | undefined;
  const parsed = parseFrom(from);
  if (parsed) {
    if (parsed.kind === 'template') {
      const t = templates.find(x => x.id === parsed.id);
      prefill = t?.input;
    } else {
      const a = await getLatest(db, parsed.id);
      prefill = a ? templateFromAnnouncement(a) : undefined;
    }
  }

  return (
    <>
      <PendingQueue
        items={pending.map(a => ({ id: a.id, title: a.title, severity: a.severity, requestedBy: a.publishRequestedBy }))}
        viewer={identity?.email ?? ''}
      />
      <ComposeForm
        templates={templates.map(t => ({ id: t.id, name: t.name }))}
        recentAnnouncements={recentAnnouncements.map(a => ({ id: a.id, title: a.title, slug: a.slug }))}
        discordRoles={discordRoles}
        prefill={prefill}
      />
    </>
  );
}

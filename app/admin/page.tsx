import ComposeForm from './compose-form.js';
import { getDb } from '../../src/web/db.js';
import { listTemplates, templateFromAnnouncement } from '../../src/core/templates.js';
import { getLatest } from '../../src/core/announcements.js';
import { listPublished } from '../../src/core/queries.js';
import type { AnnouncementInput } from '../../src/core/types.js';

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

export default async function AdminComposePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const db = getDb();

  const [templates, recentAnnouncements] = await Promise.all([
    listTemplates(db),
    listPublished(db, 20),
  ]);

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
    <ComposeForm
      templates={templates.map(t => ({ id: t.id, name: t.name }))}
      recentAnnouncements={recentAnnouncements.map(a => ({ id: a.id, title: a.title, slug: a.slug }))}
      prefill={prefill}
    />
  );
}

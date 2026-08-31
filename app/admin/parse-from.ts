// Plain module, split out of page.tsx for the same reason as
// input-from-form.ts and safe-error-message.ts: page.tsx pulls in
// next/dist/server/request/headers.js and other Next.js runtime pieces
// transitively, which makes it unsafe to import directly from a plain
// vitest test. The helpers here have no such dependency, so they live in
// this module and page.tsx imports them back.

import type { Announcement, AnnouncementInput } from '../../src/core/types.js';

export type FromKind = 'template' | 'announcement' | 'edit';

/** Parses `?from=template:<id>` / `?from=announcement:<id>` / `?from=edit:<id>` into a kind + id, or undefined. */
export function parseFrom(from: string | undefined): { kind: FromKind; id: string } | undefined {
  if (!from) return undefined;
  const [kind, ...rest] = from.split(':');
  const id = rest.join(':');
  if (!id) return undefined;
  if (kind === 'template' || kind === 'announcement' || kind === 'edit') return { kind, id };
  return undefined;
}

/**
 * Builds the AnnouncementInput used to prefill the compose form for the
 * `?from=edit:<id>` path — continuing the same announcement, so it must
 * retain the fields `templateFromAnnouncement` (src/core/templates.ts)
 * deliberately strips for the "copy into a new draft" path: `slug` and each
 * action's `deadline`. Do not simplify the edit branch in page.tsx into a
 * call to templateFromAnnouncement — that is the trap this function
 * (and its test, in test/parse-from.test.ts) exists to catch.
 */
export function editPrefillFromAnnouncement(a: Announcement): AnnouncementInput {
  return {
    type: a.type,
    networks: [...a.networks],
    audiences: [...a.audiences],
    severity: a.severity,
    title: a.title,
    bodyMd: a.bodyMd,
    actionsRequired: a.actionsRequired.map(ar => ({ ...ar, applies_to: [...ar.applies_to] })),
    links: a.links.map(l => ({ ...l })),
    slug: a.slug,
    mentionRoleIds: a.mentionRoleIds ? [...a.mentionRoleIds] : undefined,
  };
}

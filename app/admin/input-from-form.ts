// Plain (non-`'use server'`) module: `inputFromForm` is a sync pure function,
// and a `'use server'` file may only export async functions — see the same
// constraint noted in actions.ts. Splitting it out here also makes the parsing
// logic directly unit-testable without a Next.js request context.
import { normalizeNewlines } from '../../src/core/text.js';
import { normalizeSlug, slugError } from '../../src/core/slug.js';
import { utcInputToIso } from '../../src/core/datetime.js';
import { parseRoles } from '../../src/core/roles.js';
import type { AnnouncementInput, AnnouncementType, Audience, Network, Severity } from '../../src/core/types.js';

export function inputFromForm(formData: FormData): AnnouncementInput {
  const pick = (name: string): string[] => formData.getAll(name).map(String);
  const str = (name: string): string => String(formData.get(name) ?? '').trim();
  const multiline = (name: string): string => normalizeNewlines(String(formData.get(name) ?? ''));

  const actionsRequired = [];
  for (let i = 0; ; i++) {
    const action = formData.get(`action.${i}`);
    if (action === null) break;
    const trimmed = String(action).trim();
    if (!trimmed) continue;
    const deadline = String(formData.get(`deadline.${i}`) ?? '').trim();
    const appliesTo = parseRoles(String(formData.get(`appliesTo.${i}`) ?? ''));
    actionsRequired.push({
      action: trimmed,
      ...(utcInputToIso(deadline) ? { deadline: utcInputToIso(deadline)! } : {}),
      applies_to: appliesTo,
    });
  }

  const links = [];
  for (let i = 0; ; i++) {
    const label = formData.get(`linkLabel.${i}`);
    if (label === null) break;
    const trimmedLabel = String(label).trim();
    const url = String(formData.get(`linkUrl.${i}`) ?? '').trim();
    if (!trimmedLabel || !url) continue;
    links.push({ label: trimmedLabel, url });
  }

  const submittedSlug = str('slug');
  // Reject rather than coerce: normalizeSlug can turn a punctuation-only or
  // otherwise-invalid slug into a different, unrelated string (e.g. '!!!' ->
  // ''), which would otherwise silently fall back to a generated slug at
  // createDraft time. Slugs are permanent public URLs, so a silent
  // substitution is worse than a blocked submission.
  const normalizedSlug = submittedSlug ? normalizeSlug(submittedSlug) : '';
  if (submittedSlug) {
    const err = slugError(normalizedSlug);
    if (err) throw new Error(err);
  }

  return {
    type: str('type') as AnnouncementType,
    networks: pick('networks') as Network[],
    audiences: pick('audiences') as Audience[],
    severity: str('severity') as Severity,
    // Normalised like bodyMd: a title pasted from a document or chat message
    // can carry an embedded \r/\n, which would split the title across lines
    // in every renderer (each places a.title on its own line) and leave a
    // stray \r in Telegram's output.
    title: normalizeNewlines(str('title')),
    bodyMd: multiline('bodyMd'),
    actionsRequired,
    links,
    ...(submittedSlug ? { slug: normalizedSlug } : {}),
  };
}

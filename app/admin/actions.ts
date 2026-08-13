'use server';
// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/layout.tsx (tsconfig.json `paths` breaks Turbopack's dev resolver
// for that specifier).
import { headers } from 'next/dist/server/request/headers.js';
import { redirect } from 'next/navigation';
import { getDb } from '../../src/web/db.js';
import { resolveIdentity, isPublisher } from '../../src/core/identity.js';
import { createDraft } from '../../src/core/announcements.js';
import { previewAnnouncement, type PreviewSet } from '../../src/core/preview.js';
import { saveTemplate } from '../../src/core/templates.js';
import type { AnnouncementInput, AnnouncementType, Audience, Network, Severity, Template } from '../../src/core/types.js';

function inputFromForm(formData: FormData): AnnouncementInput {
  const pick = (name: string): string[] => formData.getAll(name).map(String);
  const str = (name: string): string => String(formData.get(name) ?? '').trim();

  const actionsRequired = [];
  for (let i = 0; ; i++) {
    const action = formData.get(`action.${i}`);
    if (action === null) break;
    const trimmed = String(action).trim();
    if (!trimmed) continue;
    const deadline = String(formData.get(`deadline.${i}`) ?? '').trim();
    const appliesTo = String(formData.get(`appliesTo.${i}`) ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    actionsRequired.push({
      action: trimmed,
      ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
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

  const expiresAt = str('expiresAt');

  return {
    type: str('type') as AnnouncementType,
    networks: pick('networks') as Network[],
    audiences: pick('audiences') as Audience[],
    severity: str('severity') as Severity,
    title: str('title'),
    bodyMd: str('bodyMd'),
    actionsRequired,
    links,
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  };
}

export async function createDraftAction(formData: FormData): Promise<{ id?: string; error?: string }> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  let input: AnnouncementInput;
  try {
    input = inputFromForm(formData);
  } catch {
    return { error: 'could not read form data' };
  }

  let draft;
  try {
    draft = await createDraft(db, input, identity.email);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'could not create draft' };
  }

  redirect(`/admin/review/${draft.id}`);
}

export async function saveTemplateAction(formData: FormData): Promise<{ template?: Template; error?: string }> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  const name = String(formData.get('templateName') ?? '').trim();
  if (!name) return { error: 'template name is required' };

  let input: AnnouncementInput;
  try {
    input = inputFromForm(formData);
  } catch {
    return { error: 'could not read form data' };
  }

  try {
    const template = await saveTemplate(db, { name, input, createdBy: identity.email });
    return { template };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'could not save template' };
  }
}

export async function previewAction(formData: FormData): Promise<{ preview?: PreviewSet; error?: string }> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  let input: AnnouncementInput;
  try {
    input = inputFromForm(formData);
  } catch {
    return { error: 'could not read form data' };
  }

  try {
    const preview = await previewAnnouncement(db, input);
    return { preview };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'could not build preview' };
  }
}

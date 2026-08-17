'use server';
// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/layout.tsx (tsconfig.json `paths` breaks Turbopack's dev resolver
// for that specifier).
import { headers } from 'next/dist/server/request/headers.js';
import { redirect } from 'next/navigation';
import { getDb } from '../../src/web/db.js';
import { resolveIdentity, isPublisher } from '../../src/core/identity.js';
import { createDraft, requestPublish, confirmPublish, withdrawPublish, rejectPublish } from '../../src/core/announcements.js';
import { previewAnnouncement, type PreviewSet } from '../../src/core/preview.js';
import { saveTemplate, stripPerAnnouncementFields } from '../../src/core/templates.js';
import { inputFromForm } from './input-from-form.js';
import { safeErrorMessage } from './safe-error-message.js';
import type { Announcement, AnnouncementInput, Template } from '../../src/core/types.js';

export async function createDraftAction(formData: FormData): Promise<{ id?: string; error?: string }> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  let input: AnnouncementInput;
  try {
    input = inputFromForm(formData);
  } catch (err) {
    return { error: safeErrorMessage(err, 'inputFromForm') };
  }

  let draft;
  try {
    draft = await createDraft(db, input, identity.email);
  } catch (err) {
    return { error: safeErrorMessage(err, 'createDraft') };
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
  } catch (err) {
    return { error: safeErrorMessage(err, 'inputFromForm') };
  }

  try {
    // Templates are reusable; slug and mentionRoles are announcement-specific
    // and must not be persisted into the template — see stripPerAnnouncementFields.
    const template = await saveTemplate(db, { name, input: stripPerAnnouncementFields(input), createdBy: identity.email });
    return { template };
  } catch (err) {
    return { error: safeErrorMessage(err, 'saveTemplate') };
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
  } catch (err) {
    return { error: safeErrorMessage(err, 'inputFromForm') };
  }

  try {
    const preview = await previewAnnouncement(db, input);
    return { preview };
  } catch (err) {
    return { error: safeErrorMessage(err, 'previewAnnouncement') };
  }
}

type PublishResult = { announcement?: Announcement; error?: string };

/**
 * Non-critical drafts publish immediately here (`requestPublish` performs the
 * publish itself when severity isn't critical); critical drafts move to
 * `publish_requested`. Either way, the caller re-reads the announcement to
 * render its new state.
 */
export async function requestPublishAction(id: string): Promise<PublishResult> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  try {
    const announcement = await requestPublish(db, id, identity.email);
    return { announcement };
  } catch (err) {
    return { error: safeErrorMessage(err, 'requestPublish') };
  }
}

/**
 * FourEyesError (confirmer === requester) must reach the page as a visible
 * message, never an unhandled throw / 500 — that's the whole point of the
 * four-eyes control.
 */
export async function confirmPublishAction(id: string): Promise<PublishResult> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  try {
    const announcement = await confirmPublish(db, id, identity.email);
    return { announcement };
  } catch (err) {
    return { error: safeErrorMessage(err, 'confirmPublish') };
  }
}

export async function withdrawPublishAction(id: string): Promise<PublishResult> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  try {
    const announcement = await withdrawPublish(db, id, identity.email);
    return { announcement };
  } catch (err) {
    return { error: safeErrorMessage(err, 'withdrawPublish') };
  }
}

export async function rejectPublishAction(id: string, reason: string): Promise<PublishResult> {
  const db = getDb();
  const identity = resolveIdentity(await headers());
  if (!identity || !(await isPublisher(db, identity.email))) {
    return { error: 'not authorized' };
  }

  try {
    const announcement = await rejectPublish(db, id, identity.email, reason);
    return { announcement };
  } catch (err) {
    return { error: safeErrorMessage(err, 'rejectPublish') };
  }
}

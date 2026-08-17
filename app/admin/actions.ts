'use server';
// Deep import, not `next/headers` — see the comment on the same import in
// app/admin/layout.tsx (tsconfig.json `paths` breaks Turbopack's dev resolver
// for that specifier).
import { headers } from 'next/dist/server/request/headers.js';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { getDb } from '../../src/web/db.js';
import { resolveIdentity, isPublisher } from '../../src/core/identity.js';
import { createDraft, requestPublish, confirmPublish, FourEyesError } from '../../src/core/announcements.js';
import { previewAnnouncement, type PreviewSet } from '../../src/core/preview.js';
import { saveTemplate, stripSlugForTemplate } from '../../src/core/templates.js';
import { inputFromForm } from './input-from-form.js';
import type { Announcement, AnnouncementInput, Template } from '../../src/core/types.js';

const GENERIC_ERROR = 'Something went wrong — check the server logs.';

/**
 * Maps a caught error to a message safe to send to the browser.
 *
 * ZodError and FourEyesError (and any other plain Error thrown deliberately
 * by core modules, e.g. "announcement not found: <id>") carry messages that
 * are safe and useful to show. Anything else — most importantly a raw
 * postgres driver error — may embed connection strings, hostnames, or query
 * fragments, so it's logged server-side and replaced with a generic message
 * before it ever reaches the client.
 */
function safeErrorMessage(err: unknown, context: string): string {
  if (err instanceof ZodError) return err.issues.map(i => i.message).join('; ');
  if (err instanceof FourEyesError) return err.message;
  if (err instanceof Error && err.name === 'Error') return err.message;
  console.error(`[admin/actions] ${context}:`, err);
  return GENERIC_ERROR;
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
    // Templates are reusable; the current draft's slug is announcement-specific
    // and must not be persisted into the template — see stripSlugForTemplate.
    const template = await saveTemplate(db, { name, input: stripSlugForTemplate(input), createdBy: identity.email });
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

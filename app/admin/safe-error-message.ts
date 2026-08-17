// Plain (non-`'use server'`) module, for the same reason as input-from-form.ts:
// a `'use server'` file may only export async functions, and splitting this
// out makes it directly unit-testable without a Next.js request context.
import { ZodError } from 'zod';
import { FourEyesError } from '../../src/core/announcements.js';

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
export function safeErrorMessage(err: unknown, context: string): string {
  if (err instanceof ZodError) return err.issues.map(i => i.message).join('; ');
  if (err instanceof FourEyesError) return err.message;
  if (err instanceof Error && err.name === 'Error') return err.message;
  console.error(`[admin/actions] ${context}:`, err);
  return GENERIC_ERROR;
}

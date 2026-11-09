import { z } from 'zod';
import type { AnnouncementInput } from './types.js';
import { findMentions } from './mentions.js';

/**
 * Upper bound on the markdown body. Keeps every renderer's per-line regexes
 * (bold, code, links) cheap on hostile input: several are quadratic in the
 * length of one line, which is harmless at this size. Enforced on input
 * (create, edit, preview); a stored row is re-checked without it, see
 * validateStored.
 */
export const BODY_MAX = 20_000;
const fmt = (n: number) => n.toLocaleString('en-US');

const storedSchema = z.object({
  type: z.enum(['upgrade', 'governance', 'info']),
  networks: z.array(z.enum(['mainnet', 'testnet'])).min(1),
  audiences: z.array(z.enum(['operators', 'ecosystem'])).min(1),
  severity: z.enum(['critical', 'recommended', 'info']),
  title: z.string().min(1).max(200),
  bodyMd: z.string().min(1),
  actionsRequired: z.array(z.object({
    action: z.string().min(1),
    deadline: z.string().datetime({ offset: true }).optional(),
    applies_to: z.array(z.string()),
  })),
  links: z.array(z.object({
    label: z.string().min(1),
    url: z.string().url().refine(u => /^https?:$/.test(new URL(u).protocol), 'link must be http or https'),
  })),
  supersedes: z.string().optional(),
  mentionRoleIds: z.array(z.string()).optional(),
});

const schema = storedSchema.extend({
  bodyMd: z.string().min(1).superRefine((s, ctx) => {
    if (s.length > BODY_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `The body is too long: at most ${fmt(BODY_MAX)} characters (this one has ${fmt(s.length)}).`,
      });
    }
  }),
});

// Exported so the compose form can mirror this check live in the UI —
// the warning it renders must track this exact pattern, not a copy of it.
// Defined in gh-release.ts so the compose form can import it without pulling
// this module's zod dependency into the browser bundle; re-exported here for
// server-side callers.
import { GH_RELEASE } from './gh-release.js';
export { GH_RELEASE };

/**
 * Re-check of a row that was valid when saved (review page). Same rules
 * without the body length cap, so a row stored before the cap existed still
 * renders instead of failing the page; editing it (a draft) goes through
 * validateAnnouncement and gets the length message.
 */
export function validateStored(input: AnnouncementInput): { warnings: string[] } {
  storedSchema.parse(input);
  return warningsFor(input);
}

export function validateAnnouncement(input: AnnouncementInput): { warnings: string[] } {
  schema.parse(input);
  return warningsFor(input);
}

function warningsFor(input: AnnouncementInput): { warnings: string[] } {
  const warnings: string[] = [];
  if (input.type === 'upgrade' && !input.links.some(l => GH_RELEASE.test(l.url))) {
    warnings.push('Upgrade announcements should include the official GitHub release link — binaries come from the GitHub release page.');
  }
  const mentions = findMentions(input.bodyMd);
  if (mentions.length) {
    warnings.push(
      `The body contains ${mentions.join(', ')}. Every channel receives the same body, `
      + `but only Discord turns a mention into a notification — elsewhere it appears as `
      + `plain text. Select the roles to notify on the compose form instead.`,
    );
  }
  return { warnings };
}

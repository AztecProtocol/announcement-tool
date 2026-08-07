import { z } from 'zod';
import type { AnnouncementInput } from './types.js';

const schema = z.object({
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
  links: z.array(z.object({ label: z.string().min(1), url: z.string().url() })),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  supersedes: z.string().optional(),
});

const GH_RELEASE = /^https:\/\/github\.com\/AztecProtocol\/[^/]+\/releases\//;

export function validateAnnouncement(input: AnnouncementInput): { warnings: string[] } {
  schema.parse(input);
  const warnings: string[] = [];
  if (input.type === 'upgrade' && !input.links.some(l => GH_RELEASE.test(l.url))) {
    warnings.push('Upgrade announcements should include the official GitHub release link — binaries come from the GitHub release page.');
  }
  return { warnings };
}

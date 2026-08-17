/**
 * The `applies_to` vocabulary offered in the compose form.
 *
 * Deliberately a guide rather than a closed enum: the schema documents
 * applies_to as a curated but open list, so an author can still type a role
 * that postdates this UI. The tags exist so a first-time author does not have
 * to guess the common ones.
 */
export const ROLES = ['sequencer', 'prover', 'full-node'] as const;

export function parseRoles(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const r = part.trim().toLowerCase();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

import type { Sql, JSONValue } from 'postgres';
import type { Announcement, AnnouncementInput, Template } from './types.js';
import { newTemplateId } from './ids.js';

// See the identical comment in announcements.ts: postgres's structural JSONValue
// type doesn't nominally accept our readonly interface shapes, even though they're
// valid JSON at runtime.
function asJson<T>(value: T): JSONValue {
  return value as unknown as JSONValue;
}

function rowToTemplate(r: Record<string, unknown>): Template {
  return {
    id: r.id as string,
    name: r.name as string,
    input: r.input as AnnouncementInput,
    createdBy: r.created_by as string,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export async function saveTemplate(
  sql: Sql,
  { name, input, createdBy }: { name: string; input: AnnouncementInput; createdBy: string },
): Promise<Template> {
  const [row] = await sql`
    insert into templates (id, name, input, created_by)
    values (${newTemplateId()}, ${name}, ${sql.json(asJson(input))}, ${createdBy})
    on conflict (name) do update
      set input = excluded.input, created_by = excluded.created_by, created_at = now()
    returning *`;
  return rowToTemplate(row);
}

export async function listTemplates(sql: Sql): Promise<Template[]> {
  const rows = await sql`select * from templates order by name`;
  return rows.map(rowToTemplate);
}

export async function getTemplate(sql: Sql, id: string): Promise<Template | undefined> {
  const rows = await sql`select * from templates where id = ${id} limit 1`;
  return rows[0] ? rowToTemplate(rows[0]) : undefined;
}

export async function deleteTemplate(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`delete from templates where id = ${id} returning id`;
  return rows.length > 0;
}

/**
 * Strips the slug from an AnnouncementInput before it is stored as a
 * template. Templates are reusable by definition, so a slug captured from
 * whichever draft was open when "Save as template" was clicked is stale and
 * meaningless for the next announcement created from that template — the
 * same reasoning templateFromAnnouncement below already applies to dates.
 */
export function stripSlugForTemplate(input: AnnouncementInput): AnnouncementInput {
  const { slug: _slug, ...rest } = input;
  return rest;
}

/**
 * Builds a fresh AnnouncementInput from a past announcement, for use as a
 * starting point for a new draft. Every action's `deadline` is cleared, so
 * a reused announcement can never carry a stale, already-passed deadline
 * into a new draft. Everything else (text, applies_to, links,
 * type/network/severity/audiences) is preserved. `mentionRoles` is
 * deliberately NOT carried over — a reused announcement should re-decide
 * who gets pinged, not inherit the previous author's answer, so the
 * compose form re-derives it from severity like any other new draft.
 */
export function templateFromAnnouncement(a: Announcement): AnnouncementInput {
  return {
    type: a.type,
    networks: [...a.networks],
    audiences: [...a.audiences],
    severity: a.severity,
    title: a.title,
    bodyMd: a.bodyMd,
    actionsRequired: a.actionsRequired.map(ar => ({
      action: ar.action,
      applies_to: [...ar.applies_to],
      // deadline intentionally omitted — see doc comment above.
    })),
    links: a.links.map(l => ({ ...l })),
  };
}

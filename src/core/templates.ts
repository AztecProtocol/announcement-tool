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
 * Builds a fresh AnnouncementInput from a past announcement, for use as a
 * starting point for a new draft. Every date is cleared — `expiresAt` and
 * every action's `deadline` — so a reused announcement can never carry a
 * stale, already-passed deadline into a new draft. Everything else
 * (text, applies_to, links, type/network/severity/audiences) is preserved.
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
    // expiresAt intentionally omitted — see doc comment above.
  };
}

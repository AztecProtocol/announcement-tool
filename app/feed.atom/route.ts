import { getDb } from '../../src/web/db.js';
import { listPublished } from '../../src/core/queries.js';
import { buildAtomFeed } from '../../src/core/feeds.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const items = await listPublished(getDb(), 50);
  return new Response(buildAtomFeed(items), {
    headers: { 'content-type': 'application/atom+xml; charset=utf-8' },
  });
}

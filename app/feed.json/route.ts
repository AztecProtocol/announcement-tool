import { getDb } from '../../src/web/db.js';
import { listPublished } from '../../src/core/queries.js';
import { buildJsonFeed } from '../../src/core/feeds.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const items = await listPublished(getDb(), 50);
  return Response.json(buildJsonFeed(items), {
    headers: { 'content-type': 'application/feed+json; charset=utf-8' },
  });
}

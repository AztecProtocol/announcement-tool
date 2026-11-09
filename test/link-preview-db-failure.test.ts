import { describe, expect, it, vi } from 'vitest';

// A database read failure on /a/[slug] must surface as a rejected
// generateMetadata / generateViewport (Next renders its error path), never as
// partial or site-level metadata that would look like a working page.
vi.mock('../src/core/queries.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/core/queries.js')>()),
  getPublishedBySlug: vi.fn(async () => { throw new Error('db read failed'); }),
}));
vi.mock('../src/web/db.js', () => ({ getDb: () => ({}) }));

describe('/a/[slug] metadata when the database read fails', () => {
  it('generateMetadata rejects', async () => {
    const page = await import('../app/a/[slug]/page.js');
    await expect(page.generateMetadata({ params: Promise.resolve({ slug: 'x' }) })).rejects.toThrow('db read failed');
  });
  it('generateViewport rejects', async () => {
    const page = await import('../app/a/[slug]/page.js');
    await expect(page.generateViewport({ params: Promise.resolve({ slug: 'x' }) })).rejects.toThrow('db read failed');
  });
});

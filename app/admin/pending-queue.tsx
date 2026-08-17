// Deep import, not `next/link`. tsc/NodeNext can't resolve the public
// specifier (next@16.2.12 has no "exports" map — see tsconfig.json's `paths`
// comment for the same failure mode on `next/navigation`/`next/headers`).
// Unlike those two, `Link` is a genuine runtime component export rather than
// something erased or resolved elsewhere, so a `paths` mapping to the .d.ts
// would risk the same `(void 0) is not a function` Turbopack failure that
// mapping caused for `useRouter`. The deep import sidesteps both problems.
import type { ComponentType, AnchorHTMLAttributes } from 'react';
import * as NextLink from 'next/dist/client/link.js';
// `esModuleInterop`'s default-import synthesis for this CJS `.d.ts` resolves
// inconsistently once a second module imports this file's default export —
// TS then re-widens `NextLink.default` to the whole module namespace instead
// of the `Link` component it exports at runtime (verified: `require()` at
// runtime always returns the component itself, see link.js's CJS interop
// tail). The `unknown` hop is TS's own suggested escape for this exact
// "types don't sufficiently overlap" situation; the runtime shape is correct.
const Link = NextLink.default as unknown as ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

export interface PendingItem {
  id: string;
  title: string;
  severity: string;
  requestedBy?: string;
}

/**
 * Shown at the top of the admin landing page so a second publisher can find
 * what needs confirming. Without it, four-eyes depends on someone pasting a
 * review URL into a chat.
 */
export default function PendingQueue({ items, viewer }: { items: PendingItem[]; viewer: string }) {
  if (items.length === 0) return null;
  return (
    <section className="pending-queue" aria-labelledby="pending-heading">
      <h2 id="pending-heading">Awaiting confirmation ({items.length})</h2>
      <ul>
        {items.map(item => {
          const isRequester = item.requestedBy === viewer;
          return (
            <li key={item.id}>
              <div className="pending-main">
                <span className="pending-title">{item.title}</span>
                <span className="pending-meta">
                  {item.severity} · requested by {item.requestedBy ?? 'unknown'}
                  {isRequester ? ' — you cannot confirm your own request' : ''}
                </span>
              </div>
              <Link className="pending-action" href={`/admin/review/${item.id}`}>
                {isRequester ? 'View' : 'Review'}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

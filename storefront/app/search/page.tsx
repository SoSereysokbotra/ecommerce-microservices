import { Suspense } from 'react';
import { SearchResults } from './SearchResults';

/**
 * `/search` — the read model, rendered.
 *
 * The page stays a Server Component and wraps the client part in Suspense:
 * `useSearchParams` in a client component bails the tree out of prerendering
 * up to the nearest boundary, which is what Next 16's own reference asks for
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md).
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<p className="muted">Loading search…</p>}>
      <SearchResults />
    </Suspense>
  );
}

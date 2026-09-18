'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The header search box. Submits to `/search?q=` — a plain navigation, so
 * the results page owns the query string and a result URL can be shared or
 * bookmarked. Nothing is fetched from here.
 */
export function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = q.trim();
    router.push(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
  }

  return (
    <form onSubmit={submit} role="search" className="row" style={{ gap: '0.35rem' }}>
      <input
        type="search"
        name="q"
        aria-label="Search products"
        placeholder="Search…"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        data-testid="search-box"
        style={{ padding: '0.35rem 0.5rem', width: '11rem' }}
      />
      <button type="submit" className="ghost" style={{ padding: '0.35rem 0.7rem' }}>
        Search
      </button>
    </form>
  );
}

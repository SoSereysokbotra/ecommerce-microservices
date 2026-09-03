'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';
import { useCart } from '@/components/CartProvider';

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { refresh: refreshCart } = useCart();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const body = mode === 'register' ? { email, name, password } : { email, password };
      const result = await api.post<AuthResponse>(`/auth/${mode}`, body);
      setToken(result.accessToken);

      // CartProvider lives in the layout and mounts once, so a client-side
      // navigation would not re-request the cart. Refreshing here is what sends
      // the JWT and the guest token together, which is what triggers the merge.
      await refreshCart();

      router.push('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <p className="muted small">
        Browsing does not need an account. Placing an order does.
      </p>

      <form onSubmit={submit} className="stack" style={{ maxWidth: 360, marginTop: '1.5rem' }}>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="small muted">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        {mode === 'register' && (
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="small muted">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}

        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="small muted">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="notice crit small">{error}</div>}

        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Need an account?' : 'Have an account?'}
          </button>
        </div>
      </form>
    </>
  );
}

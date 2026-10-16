'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, loading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && isAuthenticated) {
      router.push('/');
    }
  }, [loading, isAuthenticated, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await login(email, password);
      router.push('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid credentials';
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(ellipse at top, #1e293b 0%, #0a0f1d 70%)',
        padding: '1.5rem',
      }}
    >
      <div className="card-glass" style={{ maxWidth: '420px', width: '100%', padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <span className="brand-badge" style={{ marginBottom: '0.75rem', display: 'inline-block' }}>
            OPERATIONS CONSOLE
          </span>
          <h1 style={{ fontSize: '1.4rem' }}>Back-Office Sign In</h1>
          <p className="subtitle">Authorized Staff and Administrator Access Only</p>
        </div>

        {error && (
          <div
            className="alert-notice alert-crit"
            style={{ marginBottom: '1.25rem' }}
            id="login-error"
            data-testid="login-error"
          >
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="stack">
          <label className="stack" style={{ gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Staff / Admin Email</span>
            <input
              type="email"
              id="input-email"
              required
              placeholder="operator@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="stack" style={{ gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Password</span>
            <input
              type="password"
              id="input-password"
              required
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '0.75rem', padding: '0.75rem' }}
            id="btn-login"
            disabled={busy}
          >
            {busy ? 'Authenticating…' : 'Enter Back-Office Console'}
          </button>
        </form>

        <div
          style={{
            marginTop: '1.75rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--line-subtle)',
            fontSize: '0.75rem',
            color: 'var(--text-faint)',
            textAlign: 'center',
          }}
        >
          Protected by M16 Zero-Trust Role-Based Access Control (RBAC).
          <br />
          Customer accounts are rejected automatically at the perimeter.
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function PasswordResetPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [token, setTokenInput] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const res = await api.post<{ success: boolean; message: string }>(
        '/auth/password-reset/request',
        { email },
      );
      setMessage(res.message);
      setStep('confirm');
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const res = await api.post<{ success: boolean; message: string }>(
        '/auth/password-reset/confirm',
        { token: token.trim(), newPassword },
      );
      setMessage(res.message);
      setTimeout(() => {
        router.push('/login');
      }, 2500);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 420, margin: '1rem auto' }}>
      <h1>Reset Password</h1>
      <p className="muted small">
        {step === 'request'
          ? 'Enter your account email to receive a password recovery token.'
          : 'Enter the recovery token and choose your new password.'}
      </p>

      {message && <div className="notice ok small">{message}</div>}
      {error && <div className="notice crit small">{error}</div>}

      {step === 'request' ? (
        <form onSubmit={handleRequest} className="stack">
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="small muted">Account Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </label>

          <button type="submit" disabled={busy}>
            {busy ? 'Sending request…' : 'Send Recovery Token'}
          </button>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setStep('confirm');
                setError(null);
              }}
            >
              Already have a token?
            </button>
            <Link href="/login" className="small">
              Back to Sign in
            </Link>
          </div>
        </form>
      ) : (
        <form onSubmit={handleConfirm} className="stack">
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="small muted">Reset Token</span>
            <input
              type="text"
              required
              value={token}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste 64-character token"
            />
          </label>

          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="small muted">New Password (minimum 8 chars)</span>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>

          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="small muted">Confirm New Password</span>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          <button type="submit" disabled={busy}>
            {busy ? 'Resetting password…' : 'Confirm & Update Password'}
          </button>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setStep('request');
                setError(null);
              }}
            >
              Request a new token
            </button>
            <Link href="/login" className="small">
              Back to Sign in
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

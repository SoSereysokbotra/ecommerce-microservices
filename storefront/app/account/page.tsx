'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, clearToken, getToken } from '@/lib/api';
import { useCart } from '@/components/CartProvider';

interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  isEmailVerified: boolean;
}

interface DeviceSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrent: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

function parseDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown Device';
  if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
    return 'Mobile Device';
  }
  if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS')) {
    return 'Mac Desktop';
  }
  if (userAgent.includes('Windows')) {
    return 'Windows PC';
  }
  if (userAgent.includes('Linux')) {
    return 'Linux Device';
  }
  return 'Web Browser';
}

export default function AccountPage() {
  const router = useRouter();
  const { refresh: refreshCart } = useCart();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    loadData();
  }, [router]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [profileData, sessionsData] = await Promise.all([
        api.get<UserProfile>('/users/profile'),
        api.get<DeviceSession[]>('/auth/sessions'),
      ]);
      setProfile(profileData);
      setSessions(sessionsData);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await api.post('/auth/logout');
    } catch (_) {}
    clearToken();
    await refreshCart();
    router.push('/login');
  }

  async function revokeSession(id: string) {
    setBusySessionId(id);
    setMessage(null);
    setError(null);
    try {
      await api.del(`/auth/sessions/${id}`);
      setMessage('Session revoked successfully');
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(null);
    }
  }

  async function revokeOtherSessions() {
    setBusySessionId('all-others');
    setMessage(null);
    setError(null);
    try {
      const res = await api.del<{ message: string; revokedCount: number }>('/auth/sessions');
      setMessage(res.message || 'Logged out of other devices successfully');
      setSessions((prev) => prev.filter((s) => s.isCurrent));
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(null);
    }
  }

  if (loading) {
    return <p className="muted">Loading account details…</p>;
  }

  if (!profile) {
    return (
      <div className="notice crit">
        <p>Could not load account details.</p>
        <Link href="/login" className="btn small" style={{ marginTop: '0.5rem', display: 'inline-block' }}>
          Sign In Again
        </Link>
      </div>
    );
  }

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>My Account</h1>
          <p className="muted small">Manage your profile, security, and active sessions</p>
        </div>
        <button type="button" onClick={handleLogout} className="ghost small">
          Sign out
        </button>
      </div>

      {message && <div className="notice ok small">{message}</div>}
      {error && <div className="notice crit small">{error}</div>}

      <div className="card">
        <h2>Profile Information</h2>
        <div className="row" style={{ gap: '2rem', flexWrap: 'wrap' }}>
          <div>
            <span className="small muted">Name</span>
            <div style={{ fontWeight: 600 }}>{profile.name}</div>
          </div>
          <div>
            <span className="small muted">Email</span>
            <div style={{ fontWeight: 600 }}>{profile.email}</div>
          </div>
          <div>
            <span className="small muted">Role</span>
            <div>
              <span className="pill info">{profile.role}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <Link href="/password-reset" className="small">
            Reset or Change Password →
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2>Active Devices &amp; Sessions</h2>
            <p className="small muted" style={{ margin: 0 }}>
              Device sessions authorized to access your account
            </p>
          </div>
          {otherSessionsCount > 0 && (
            <button
              type="button"
              className="ghost small"
              disabled={busySessionId === 'all-others'}
              onClick={revokeOtherSessions}
            >
              {busySessionId === 'all-others' ? 'Revoking…' : 'Log out other devices'}
            </button>
          )}
        </div>

        <div className="stack" style={{ marginTop: '1rem', gap: '0.75rem' }}>
          {sessions.map((s) => {
            const deviceName = parseDeviceName(s.userAgent);
            const isBusy = busySessionId === s.id;
            const createdDate = new Date(s.createdAt).toLocaleString();

            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.75rem',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius)',
                  background: s.isCurrent ? '#f9fcfb' : 'var(--surface)',
                }}
              >
                <div>
                  <div className="row" style={{ gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600 }}>{deviceName}</span>
                    {s.isCurrent ? (
                      <span className="pill ok">Current device</span>
                    ) : (
                      <span className="pill info">Active</span>
                    )}
                  </div>
                  <div className="small muted" style={{ marginTop: '0.2rem' }}>
                    IP: {s.ipAddress || 'Unknown'} · Signed in: {createdDate}
                  </div>
                </div>

                {!s.isCurrent && (
                  <button
                    type="button"
                    className="ghost small"
                    disabled={isBusy}
                    onClick={() => revokeSession(s.id)}
                    style={{ color: 'var(--crit)' }}
                  >
                    {isBusy ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

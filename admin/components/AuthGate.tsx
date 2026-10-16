'use client';

import React, { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth, UserRole } from '@/lib/auth-context';

interface AuthGateProps {
  children: React.ReactNode;
  requiredRole?: UserRole;
}

export function AuthGate({ children, requiredRole }: AuthGateProps) {
  const { user, loading, isAuthenticated, isAdmin } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !isAuthenticated && pathname !== '/login') {
      router.push('/login');
    }
  }, [loading, isAuthenticated, pathname, router]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--bg-primary)',
          gap: '1rem',
        }}
        data-testid="auth-loading"
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid var(--line-subtle)',
            borderTopColor: 'var(--accent-primary)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Verifying security perimeter & operational credentials…
        </p>
        <style jsx>{`
          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}</style>
      </div>
    );
  }

  if (!isAuthenticated && pathname !== '/login') {
    return null; // Will redirect via useEffect
  }

  if (requiredRole === 'ADMIN' && !isAdmin) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center' }} data-testid="forbidden-gate">
        <div className="card" style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'center' }}>
          <span className="pill pill-crit" style={{ alignSelf: 'center', marginBottom: '1rem' }}>
            403 Forbidden
          </span>
          <h2>Administrator Privilege Required</h2>
          <p className="subtitle" style={{ marginBottom: '1.5rem' }}>
            Your account ({user?.email}) has Staff privileges, but this section requires the Administrator role.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => router.push('/')}
            style={{ alignSelf: 'center' }}
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

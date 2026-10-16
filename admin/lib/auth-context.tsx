'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, setAdminToken, clearAdminToken } from './api';

export type UserRole = 'ADMIN' | 'STAFF' | 'CUSTOMER';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  isEmailVerified: boolean;
  createdAt?: string;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: AdminUser;
}

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isStaff: boolean;
  isStaffOrAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await api.get<AdminUser>('/users/profile');
      if (profile.role !== 'ADMIN' && profile.role !== 'STAFF') {
        clearAdminToken();
        setUser(null);
        setError('Access denied: Staff or Administrator privileges required.');
      } else {
        setUser(profile);
        setError(null);
      }
    } catch {
      clearAdminToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    api
      .get<AdminUser>('/users/profile')
      .then((profile) => {
        if (!mounted) return;
        if (profile.role !== 'ADMIN' && profile.role !== 'STAFF') {
          clearAdminToken();
          setUser(null);
          setError('Access denied: Staff or Administrator privileges required.');
        } else {
          setUser(profile);
          setError(null);
        }
      })
      .catch(() => {
        if (!mounted) return;
        clearAdminToken();
        setUser(null);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<LoginResponse>('/auth/login', { email, password });
      if (res.user.role !== 'ADMIN' && res.user.role !== 'STAFF') {
        clearAdminToken();
        setUser(null);
        throw new Error('Access denied: You need an Administrator or Staff role to access the back-office.');
      }

      setAdminToken(res.accessToken);
      setUser(res.user);
    } catch (err) {
      clearAdminToken();
      setUser(null);
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore network logout failures on teardown */
    } finally {
      clearAdminToken();
      setUser(null);
      setError(null);
      router.push('/login');
    }
  };

  const isAdmin = user?.role === 'ADMIN';
  const isStaff = user?.role === 'STAFF';
  const isStaffOrAdmin = isAdmin || isStaff;
  const isAuthenticated = !!user && isStaffOrAdmin;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        isAuthenticated,
        isAdmin,
        isStaff,
        isStaffOrAdmin,
        login,
        logout,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

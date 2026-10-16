'use client';

import React, { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { useAuth, UserRole } from '@/lib/auth-context';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/formatters';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  isEmailVerified: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

interface PaginatedUsers {
  items: UserRecord[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export default function UsersPage() {
  const { user: currentUser, isAdmin } = useAuth();

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 15, totalPages: 1 });
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Role Edit Modal State
  const [roleModalUser, setRoleModalUser] = useState<UserRecord | null>(null);
  const [selectedRole, setSelectedRole] = useState<UserRole>('CUSTOMER');
  const [roleSaving, setRoleSaving] = useState<boolean>(false);

  // Status Edit Modal State
  const [statusModalUser, setStatusModalUser] = useState<UserRecord | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<'ACTIVE' | 'SUSPENDED' | 'BANNED'>('ACTIVE');
  const [statusSaving, setStatusSaving] = useState<boolean>(false);

  const fetchUsers = async (page: number = 1, searchQuery?: string, role?: string, status?: string) => {
    setLoading(true);
    setFeedback(null);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(meta.limit));
      if (searchQuery !== undefined ? searchQuery : search) {
        params.set('search', searchQuery !== undefined ? searchQuery : search);
      }
      if ((role !== undefined ? role : roleFilter)) {
        params.set('role', role !== undefined ? role : roleFilter);
      }
      if ((status !== undefined ? status : statusFilter)) {
        params.set('status', status !== undefined ? status : statusFilter);
      }

      const res = await api.get<PaginatedUsers>(`/users?${params.toString()}`);
      setUsers(res.items || []);
      setMeta(res.meta || { total: 0, page: 1, limit: 15, totalPages: 1 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load user directory';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void api.get<PaginatedUsers>('/users?page=1&limit=15').then((res) => {
      if (!mounted) return;
      setUsers(res.items || []);
      setMeta(res.meta || { total: 0, page: 1, limit: 15, totalPages: 1 });
      setLoading(false);
    }).catch(() => {
      if (mounted) setLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchUsers(1, search, roleFilter, statusFilter);
  };

  const handleRoleFilterChange = (val: string) => {
    setRoleFilter(val);
    fetchUsers(1, search, val, statusFilter);
  };

  const handleStatusFilterChange = (val: string) => {
    setStatusFilter(val);
    fetchUsers(1, search, roleFilter, val);
  };

  // Open Role Modal
  const openRoleModal = (u: UserRecord) => {
    setRoleModalUser(u);
    setSelectedRole(u.role);
  };

  // Save Role
  const handleSaveRole = async () => {
    if (!roleModalUser) return;
    setRoleSaving(true);
    try {
      await api.patch(`/users/${roleModalUser.id}/role`, { role: selectedRole });
      setFeedback({
        type: 'ok',
        text: `Role for ${roleModalUser.email} updated to ${selectedRole} successfully.`,
      });
      setRoleModalUser(null);
      fetchUsers(meta.page);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to update user role';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setRoleSaving(false);
    }
  };

  // Open Status Modal
  const openStatusModal = (u: UserRecord) => {
    setStatusModalUser(u);
    setSelectedStatus(u.status);
  };

  // Save Status
  const handleSaveStatus = async () => {
    if (!statusModalUser) return;
    setStatusSaving(true);
    try {
      await api.patch(`/users/${statusModalUser.id}/status`, { status: selectedStatus });
      setFeedback({
        type: 'ok',
        text: `Status for ${statusModalUser.email} updated to ${selectedStatus}. Active sessions revoked.`,
      });
      setStatusModalUser(null);
      fetchUsers(meta.page);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to update account status';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <AuthGate>
      <div className="stack" style={{ gap: '1.75rem' }}>
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.25rem' }}>
              <h1>User Directory & Access Control</h1>
              <span className="pill pill-staff">
                {meta.total} Registered Accounts
              </span>
            </div>
            <p className="subtitle">
              Manage user lifecycles, assign role privileges, and inspect security statuses.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => fetchUsers(meta.page)}
            disabled={loading}
            id="btn-refresh-users"
            style={{ fontSize: '0.8rem' }}
          >
            {loading ? 'Refreshing…' : '↻ Refresh Directory'}
          </button>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div
            className={`alert-notice ${feedback.type === 'ok' ? 'alert-ok' : 'alert-crit'}`}
            id="user-feedback-alert"
          >
            <span>{feedback.text}</span>
          </div>
        )}

        {/* Filter and Search Bar */}
        <div className="card filter-toolbar">
          <form onSubmit={handleSearchSubmit} className="search-input-wrapper" style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              id="input-user-search"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%' }}
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '0.55rem 0.9rem' }}>
              Search
            </button>
          </form>

          <div className="row" style={{ gap: '0.75rem' }}>
            <select
              id="select-role-filter"
              value={roleFilter}
              onChange={(e) => handleRoleFilterChange(e.target.value)}
            >
              <option value="">All Roles</option>
              <option value="ADMIN">Administrators</option>
              <option value="STAFF">Staff Operators</option>
              <option value="CUSTOMER">Customers</option>
            </select>

            <select
              id="select-status-filter"
              value={statusFilter}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="BANNED">Banned</option>
            </select>
          </div>
        </div>

        {/* Users Table */}
        <div className="table-container" data-testid="users-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Account Status</th>
                <th>Email Verified</th>
                <th>Registered</th>
                <th>Last Login</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} style={{ textAlign: 'center', padding: '3rem' }}>
                    <p className="subtitle">Loading user records…</p>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} style={{ textAlign: 'center', padding: '3rem' }}>
                    <p className="subtitle">No users found matching current filters.</p>
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isSelf = currentUser?.id === u.id;
                  return (
                    <tr key={u.id} id={`user-row-${u.id}`}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '50%',
                              background: u.role === 'ADMIN' ? 'var(--badge-admin-bg)' : 'var(--bg-secondary)',
                              color: u.role === 'ADMIN' ? 'var(--badge-admin)' : 'var(--text-muted)',
                              border: '1px solid var(--line-subtle)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                              fontSize: '0.8rem',
                            }}
                          >
                            {(u.name || u.email || 'U')[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {u.name || 'Unnamed User'}{' '}
                              {isSelf && (
                                <span style={{ fontSize: '0.7rem', color: 'var(--accent-primary)' }}>
                                  (You)
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                              {u.email}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td>
                        <span
                          className={`pill ${
                            u.role === 'ADMIN'
                              ? 'pill-admin'
                              : u.role === 'STAFF'
                              ? 'pill-staff'
                              : 'pill-customer'
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>

                      <td>
                        <span
                          className={`pill ${
                            u.status === 'ACTIVE'
                              ? 'pill-ok'
                              : u.status === 'SUSPENDED'
                              ? 'pill-warn'
                              : 'pill-crit'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>

                      <td>
                        <span style={{ fontSize: '0.8rem', color: u.isEmailVerified ? 'var(--status-ok)' : 'var(--text-faint)' }}>
                          {u.isEmailVerified ? '✓ Verified' : 'Unverified'}
                        </span>
                      </td>

                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {formatDate(u.createdAt)}
                      </td>

                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {formatDate(u.lastLoginAt)}
                      </td>

                      {isAdmin && (
                        <td>
                          <div className="row" style={{ gap: '0.4rem' }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => openRoleModal(u)}
                              style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                              id={`btn-edit-role-${u.id}`}
                            >
                              Role
                            </button>

                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => openStatusModal(u)}
                              style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                              id={`btn-edit-status-${u.id}`}
                            >
                              Status
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {/* Pagination Controls */}
          <div className="pagination-bar">
            <span>
              Showing Page <strong>{meta.page}</strong> of <strong>{meta.totalPages}</strong> ({meta.total} total)
            </span>

            <div className="row" style={{ gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={meta.page <= 1 || loading}
                onClick={() => fetchUsers(meta.page - 1)}
                id="btn-prev-page"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={meta.page >= meta.totalPages || loading}
                onClick={() => fetchUsers(meta.page + 1)}
                id="btn-next-page"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}
              >
                Next →
              </button>
            </div>
          </div>
        </div>

        {/* Change Role Modal */}
        {roleModalUser && (
          <div className="modal-backdrop" id="modal-role-backdrop">
            <div className="modal-card">
              <h2>Assign User Role</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Change system privileges for <strong style={{ color: 'var(--text-main)' }}>{roleModalUser.email}</strong>.
              </p>

              {currentUser?.id === roleModalUser.id && (
                <div className="alert-notice alert-crit" style={{ marginBottom: '1rem', fontSize: '0.78rem' }}>
                  ⚠️ M16 Security Rule: You cannot revoke your own Administrator role.
                </div>
              )}

              <div className="stack" style={{ gap: '0.75rem', marginBottom: '1.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="role"
                    value="ADMIN"
                    checked={selectedRole === 'ADMIN'}
                    onChange={() => setSelectedRole('ADMIN')}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>Administrator (ADMIN)</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Full operational privileges, system maintenance, and role management.
                    </div>
                  </div>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="role"
                    value="STAFF"
                    checked={selectedRole === 'STAFF'}
                    disabled={currentUser?.id === roleModalUser.id}
                    onChange={() => setSelectedRole('STAFF')}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>Staff Operator (STAFF)</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Order fulfillment, catalog updates, review moderation, and customer support.
                    </div>
                  </div>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="role"
                    value="CUSTOMER"
                    checked={selectedRole === 'CUSTOMER'}
                    disabled={currentUser?.id === roleModalUser.id}
                    onChange={() => setSelectedRole('CUSTOMER')}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>Shopper (CUSTOMER)</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Standard customer access without back-office privileges.
                    </div>
                  </div>
                </label>
              </div>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRoleModalUser(null)}
                  disabled={roleSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveRole}
                  disabled={roleSaving || selectedRole === roleModalUser.role}
                  id="btn-save-role"
                >
                  {roleSaving ? 'Saving…' : 'Update Role'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Change Status Modal */}
        {statusModalUser && (
          <div className="modal-backdrop" id="modal-status-backdrop">
            <div className="modal-card">
              <h2>Account Lifecycle Status</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Update account access for <strong style={{ color: 'var(--text-main)' }}>{statusModalUser.email}</strong>.
              </p>

              {currentUser?.id === statusModalUser.id && (
                <div className="alert-notice alert-crit" style={{ marginBottom: '1rem', fontSize: '0.78rem' }}>
                  ⚠️ M16 Security Rule: Administrators cannot suspend or ban their own account.
                </div>
              )}

              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Note: Setting status to <strong>SUSPENDED</strong> or <strong>BANNED</strong> will immediately revoke all
                associated device sessions in Redis and database, blocking subsequent access.
              </p>

              <div className="stack" style={{ gap: '0.75rem', marginBottom: '1.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="status"
                    value="ACTIVE"
                    checked={selectedStatus === 'ACTIVE'}
                    onChange={() => setSelectedStatus('ACTIVE')}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--status-ok)' }}>ACTIVE</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Account is in good standing and can authenticate normally.
                    </div>
                  </div>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="status"
                    value="SUSPENDED"
                    checked={selectedStatus === 'SUSPENDED'}
                    disabled={currentUser?.id === statusModalUser.id}
                    onChange={() => setSelectedStatus('SUSPENDED')}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--status-warn)' }}>SUSPENDED</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Temporarily disabled. Ongoing sessions terminated immediately.
                    </div>
                  </div>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="status"
                    value="BANNED"
                    checked={selectedStatus === 'BANNED'}
                    disabled={currentUser?.id === statusModalUser.id}
                    onChange={() => setSelectedStatus('BANNED')}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--status-crit)' }}>BANNED</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Permanently banned from accessing the platform.
                    </div>
                  </div>
                </label>
              </div>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setStatusModalUser(null)}
                  disabled={statusSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveStatus}
                  disabled={statusSaving || selectedStatus === statusModalUser.status}
                  id="btn-save-status"
                >
                  {statusSaving ? 'Updating…' : 'Apply Status Change'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGate>
  );
}

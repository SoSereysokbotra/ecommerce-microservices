'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/formatters';

interface ReviewRecord {
  id: string;
  productId: string;
  customerId: string;
  orderId: string;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  status: 'pending' | 'approved' | 'rejected';
  moderatedAt?: string | null;
  moderationNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedModerationResponse {
  items: ReviewRecord[];
  total: number;
  page: number;
  limit: number;
}

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Moderation Modal State
  const [activeReview, setActiveReview] = useState<ReviewRecord | null>(null);
  const [moderationAction, setModerationAction] = useState<'approve' | 'reject'>('approve');
  const [moderationNote, setModerationNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Replay Rollup State
  const [republishing, setRepublishing] = useState<boolean>(false);

  const fetchModerationQueue = async (targetStatus = statusFilter, targetPage = page) => {
    setLoading(true);
    try {
      const res = await api.get<PaginatedModerationResponse>(
        `/reviews/moderation?status=${targetStatus}&page=${targetPage}&limit=15`,
      );
      setReviews(res.items || []);
      setTotal(res.total || 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch review moderation queue';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    api
      .get<PaginatedModerationResponse>(
        `/reviews/moderation?status=${statusFilter}&page=${page}&limit=15`,
      )
      .then((res) => {
        if (!mounted) return;
        setReviews(res.items || []);
        setTotal(res.total || 0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to fetch review moderation queue';
        setFeedback({ type: 'crit', text: msg });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [statusFilter, page]);

  const openModerationModal = (review: ReviewRecord, action: 'approve' | 'reject') => {
    setActiveReview(review);
    setModerationAction(action);
    setModerationNote(
      action === 'approve'
        ? 'Verified authentic customer feedback'
        : 'Violates community guidelines / inappropriate content',
    );
    setSubmitting(false);
  };

  const handleModerationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReview) return;

    setSubmitting(true);
    setFeedback(null);

    try {
      const endpoint = `/reviews/${activeReview.id}/${moderationAction}`;
      await api.post(endpoint, {
        moderationNote: moderationNote.trim() || undefined,
      });

      // Update in-memory reviews or remove from current filtered tab
      setReviews((prev) => prev.filter((r) => r.id !== activeReview.id));
      setTotal((prev) => Math.max(0, prev - 1));

      setFeedback({
        type: 'ok',
        text: `Review #${activeReview.id.slice(0, 8)} by ${activeReview.authorName} successfully ${moderationAction === 'approve' ? 'APPROVED' : 'REJECTED'}.`,
      });
      setActiveReview(null);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : `Failed to ${moderationAction} review`;
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRepublishRollups = async () => {
    setRepublishing(true);
    setFeedback(null);
    try {
      const res = await api.post<{ ratings: number }>('/reviews/admin/republish', {});
      setFeedback({
        type: 'ok',
        text: `Successfully re-emitted product.rating_changed events for ${res.ratings} active product rating rollups.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to rebuild rating rollups';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setRepublishing(false);
    }
  };

  const renderStars = (rating: number) => {
    return (
      <span style={{ color: '#f59e0b', fontSize: '1rem', letterSpacing: '0.1em' }}>
        {'★'.repeat(rating)}
        {'☆'.repeat(5 - rating)}
      </span>
    );
  };

  return (
    <AuthGate>
      <div className="content-container">
        {/* Top Header */}
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}
        >
          <div>
            <h1>Customer Reviews Moderation Queue</h1>
            <p className="subtitle">
              Verify customer reviews, uphold community standards, and trigger rating rollup
              synchronizations.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <button
              id="btn-republish-ratings"
              type="button"
              className="btn btn-secondary"
              onClick={handleRepublishRollups}
              disabled={republishing}
              title="Re-emit rating events across the event mesh"
            >
              {republishing ? 'Rebuilding Rollups…' : '↻ Sync Rating Rollups'}
            </button>
            <button
              id="btn-refresh-reviews"
              type="button"
              className="btn btn-secondary"
              onClick={() => fetchModerationQueue(statusFilter, page)}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : '↻ Refresh Queue'}
            </button>
          </div>
        </div>

        {/* Global Feedback Banner */}
        {feedback && (
          <div
            className={`pill ${feedback.type === 'ok' ? 'pill-ok' : 'pill-crit'}`}
            style={{
              display: 'flex',
              padding: '0.75rem 1rem',
              borderRadius: 'var(--radius-sm)',
              marginBottom: '1.5rem',
              fontSize: '0.85rem',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{feedback.text}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Status Filter Tabs */}
        <div className="row" style={{ gap: '0.75rem', marginBottom: '1.5rem' }}>
          <button
            type="button"
            className={`btn ${statusFilter === 'pending' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setStatusFilter('pending');
              setPage(1);
            }}
            id="tab-pending-reviews"
          >
            Pending Moderation {statusFilter === 'pending' && `(${total})`}
          </button>
          <button
            type="button"
            className={`btn ${statusFilter === 'approved' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setStatusFilter('approved');
              setPage(1);
            }}
            id="tab-approved-reviews"
          >
            Approved Reviews {statusFilter === 'approved' && `(${total})`}
          </button>
          <button
            type="button"
            className={`btn ${statusFilter === 'rejected' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setStatusFilter('rejected');
              setPage(1);
            }}
            id="tab-rejected-reviews"
          >
            Rejected Submissions {statusFilter === 'rejected' && `(${total})`}
          </button>
        </div>

        {/* Review Items List */}
        {loading && reviews.length === 0 ? (
          <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
            <p className="subtitle">Loading review moderation feed…</p>
          </div>
        ) : reviews.length === 0 ? (
          <div className="card" style={{ padding: '3.5rem', textAlign: 'center' }}>
            <h3>No Reviews in &apos;{statusFilter.toUpperCase()}&apos; Queue</h3>
            <p className="subtitle" style={{ marginTop: '0.4rem' }}>
              {statusFilter === 'pending'
                ? 'All customer submissions have been moderated. Check back as new purchases arrive.'
                : `There are currently no ${statusFilter} customer reviews.`}
            </p>
          </div>
        ) : (
          <div className="stack" style={{ gap: '1.25rem' }}>
            {reviews.map((rev) => (
              <div
                key={rev.id}
                className="card"
                id={`card-review-${rev.id}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.85rem',
                  borderLeft: `4px solid ${
                    rev.status === 'approved'
                      ? 'var(--status-ok)'
                      : rev.status === 'rejected'
                        ? 'var(--status-crit)'
                        : 'var(--status-warn)'
                  }`,
                }}
              >
                {/* Header Row */}
                <div
                  className="row"
                  style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                >
                  <div>
                    <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
                      {renderStars(rev.rating)}
                      <h3 style={{ fontSize: '1.05rem', margin: 0 }}>{rev.title}</h3>
                      <span
                        className={`pill ${
                          rev.status === 'approved'
                            ? 'pill-ok'
                            : rev.status === 'rejected'
                              ? 'pill-crit'
                              : 'pill-warn'
                        }`}
                      >
                        {rev.status.toUpperCase()}
                      </span>
                    </div>

                    <div
                      className="row"
                      style={{
                        gap: '0.75rem',
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                        marginTop: '0.3rem',
                      }}
                    >
                      <span>
                        Author: <strong>{rev.authorName}</strong>
                      </span>
                      <span>•</span>
                      <span>
                        Verified Order:{' '}
                        <Link href={`/orders?id=${rev.orderId}`}>
                          <code style={{ color: 'var(--accent-secondary)' }}>
                            {rev.orderId.slice(0, 8)}
                          </code>
                        </Link>
                      </span>
                      <span>•</span>
                      <span>
                        Product ID: <code>{rev.productId.slice(0, 8)}</code>
                      </span>
                      <span>•</span>
                      <span>Submitted: {formatDate(rev.createdAt)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="row" style={{ gap: '0.5rem' }}>
                    {rev.status !== 'approved' && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                        onClick={() => openModerationModal(rev, 'approve')}
                        id={`btn-approve-${rev.id}`}
                      >
                        ✓ Approve
                      </button>
                    )}
                    {rev.status !== 'rejected' && (
                      <button
                        type="button"
                        className="btn btn-danger"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                        onClick={() => openModerationModal(rev, 'reject')}
                        id={`btn-reject-${rev.id}`}
                      >
                        ✕ Reject
                      </button>
                    )}
                  </div>
                </div>

                {/* Body Content */}
                <p
                  style={{
                    color: 'var(--text-main)',
                    fontSize: '0.9rem',
                    lineHeight: 1.6,
                    margin: 0,
                  }}
                >
                  {rev.body}
                </p>

                {/* Audit & Note footer (if present) */}
                {(rev.moderationNote || rev.moderatedAt) && (
                  <div
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.78rem',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--line-subtle)',
                    }}
                  >
                    <strong>Moderation Record:</strong> {rev.moderationNote || 'No notes left'}
                    {rev.moderatedAt && ` (At: ${formatDate(rev.moderatedAt)})`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Moderation Decision Modal */}
        {activeReview && (
          <div
            className="modal-backdrop"
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 100,
              backdropFilter: 'blur(4px)',
            }}
          >
            <div
              className="card"
              style={{
                width: '100%',
                maxWidth: '480px',
                padding: '1.75rem',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              <h2>
                {moderationAction === 'approve'
                  ? 'Approve Customer Review'
                  : 'Reject Customer Review'}
              </h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                {moderationAction === 'approve'
                  ? 'Approving publishes this review to storefront product pages and increments rating rollups.'
                  : 'Rejecting hides this review from shoppers and recalculates rating rollups.'}
              </p>

              <form onSubmit={handleModerationSubmit} className="stack" style={{ gap: '1rem' }}>
                <div
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    padding: '0.85rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--line-subtle)',
                    fontSize: '0.85rem',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                    &ldquo;{activeReview.title}&rdquo; — {renderStars(activeReview.rating)}
                  </div>
                  <div
                    style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}
                  >
                    &ldquo;{activeReview.body}&rdquo;
                  </div>
                  <div
                    style={{
                      color: 'var(--text-faint)',
                      fontSize: '0.75rem',
                      marginTop: '0.35rem',
                    }}
                  >
                    Author: {activeReview.authorName}
                  </div>
                </div>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Internal Moderation Note (Optional)
                  </span>
                  <input
                    id="input-moderation-note"
                    type="text"
                    value={moderationNote}
                    onChange={(e) => setModerationNote(e.target.value)}
                    placeholder="e.g. Verified customer photo, Violates review guidelines"
                    maxLength={200}
                  />
                </label>

                <div
                  className="row"
                  style={{ justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setActiveReview(null)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={
                      moderationAction === 'approve' ? 'btn btn-primary' : 'btn btn-danger'
                    }
                    disabled={submitting}
                    id="btn-confirm-moderation"
                  >
                    {submitting
                      ? 'Processing…'
                      : moderationAction === 'approve'
                        ? 'Confirm Approval'
                        : 'Confirm Rejection'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AuthGate>
  );
}

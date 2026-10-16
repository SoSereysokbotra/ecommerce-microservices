/**
 * Reusable formatting utilities for Admin Dashboard.
 */

export function formatMoney(minor: number, currency: string = 'USD'): string {
  if (isNaN(minor)) return '$0.00';

  const code = (currency || 'USD').toUpperCase();
  const isZeroDecimal = code === 'JPY';
  const amount = isZeroDecimal ? minor : minor / 100;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: isZeroDecimal ? 0 : 2,
      maximumFractionDigits: isZeroDecimal ? 0 : 2,
    }).format(amount);
  } catch {
    return `${code} ${(minor / 100).toFixed(2)}`;
  }
}

export function formatDate(dateInput: string | Date | undefined | null): string {
  if (!dateInput) return '—';
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return String(dateInput);
  }
}

export function getOrderStatusBadgeClass(status: string): string {
  switch (status?.toUpperCase()) {
    case 'CONFIRMED':
    case 'DELIVERED':
    case 'PAID':
      return 'pill-ok';
    case 'SHIPPED':
    case 'DISPATCHED':
    case 'ACTIVE':
      return 'pill-staff';
    case 'PENDING':
    case 'AWAITING_PAYMENT':
    case 'PROCESSING':
    case 'REFUNDED':
      return 'pill-warn';
    case 'CANCELLED':
    case 'FAILED':
    case 'REJECTED':
    case 'BANNED':
    case 'SUSPENDED':
      return 'pill-crit';
    default:
      return 'pill-customer';
  }
}

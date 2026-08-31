export function formatIsoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function daysBetween(start: Date | string, end: Date | string): number {
  const startDate = new Date(start).getTime();
  const endDate = new Date(end).getTime();
  const diffMs = Math.abs(endDate - startDate);
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

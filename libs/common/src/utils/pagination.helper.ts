import { PaginatedResponse, PaginatedResponseMeta } from '@libs/shared-types';

export function createPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResponse<T> {
  return {
    data,
    meta: calculatePaginationMeta(total, page, limit),
  };
}

export function calculatePaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginatedResponseMeta {
  return {
    total,
    page,
    limit,
    lastPage: Math.max(1, Math.ceil(total / limit)),
  };
}

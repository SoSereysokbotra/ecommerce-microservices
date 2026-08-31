export interface PaginatedResponseMeta {
  total: number;
  page: number;
  limit: number;
  lastPage: number;
}

export type PaginationMeta = PaginatedResponseMeta;

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginatedResponseMeta;
}

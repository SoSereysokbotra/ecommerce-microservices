import { HttpException, HttpStatus } from '@nestjs/common';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unexpected error';
}

export function throwNotFound(entity: string, id: string): never {
  throw new HttpException(`${entity} with ID ${id} not found`, HttpStatus.NOT_FOUND);
}

export function throwConflict(message: string): never {
  throw new HttpException(message, HttpStatus.CONFLICT);
}

export function throwForbidden(message = 'Access denied'): never {
  throw new HttpException(message, HttpStatus.FORBIDDEN);
}

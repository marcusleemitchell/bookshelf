/**
 * Application errors mapped to `{ error: { code, message } }` responses (SPEC §5).
 */
import type { ErrorCode } from '../../shared/index.ts';

export type ErrorStatus = 400 | 404 | 409 | 500 | 502;

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: ErrorStatus, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError(400, 'validation_error', message, details);
}

export function notFound(what: string): AppError {
  return new AppError(404, 'not_found', `${what} not found`);
}

export function conflict(message: string): AppError {
  return new AppError(409, 'conflict', message);
}

export function upstreamError(message: string): AppError {
  return new AppError(502, 'upstream_error', message);
}

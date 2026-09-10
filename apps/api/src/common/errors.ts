import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode, ProblemFieldError } from '@audit5s/contracts';

/**
 * The one exception type this API throws.
 *
 * Every failure carries a stable machine `code` (ARCHITECTURE.md §8.1) so clients branch
 * on that rather than on the status or the prose, and the filter renders it as RFC 7807.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: HttpStatus,
    readonly title: string,
    readonly detail?: string,
    readonly fieldErrors?: ProblemFieldError[],
  ) {
    super(title, status);
  }

  static badRequest(code: ErrorCode, title: string, detail?: string): AppError {
    return new AppError(code, HttpStatus.BAD_REQUEST, title, detail);
  }

  static validation(detail: string, fieldErrors?: ProblemFieldError[]): AppError {
    return new AppError(
      'VALIDATION_FAILED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Validation failed',
      detail,
      fieldErrors,
    );
  }

  static unauthorized(code: ErrorCode, detail?: string): AppError {
    return new AppError(code, HttpStatus.UNAUTHORIZED, 'Unauthorized', detail);
  }

  static forbidden(code: ErrorCode = 'FORBIDDEN', detail?: string): AppError {
    return new AppError(code, HttpStatus.FORBIDDEN, 'Forbidden', detail);
  }

  /**
   * AZ-3: an out-of-scope *read* is a 404, not a 403, so object IDs cannot be probed for
   * existence. Callers should reach for this rather than `forbidden` on reads.
   */
  static notFound(detail?: string): AppError {
    return new AppError('NOT_FOUND', HttpStatus.NOT_FOUND, 'Not found', detail);
  }

  static conflict(code: ErrorCode, detail?: string): AppError {
    return new AppError(code, HttpStatus.CONFLICT, 'Conflict', detail);
  }

  /**
   * U-1: a Coordinator sending `name` or `code` gets the offending fields named, rather
   * than a silent drop or a generic rejection.
   */
  static fieldNotEditable(fields: string[]): AppError {
    return new AppError(
      'FIELD_NOT_EDITABLE',
      HttpStatus.FORBIDDEN,
      'Field not editable',
      `Your role may not change: ${fields.join(', ')}`,
      fields.map((field) => ({ field, message: 'Not editable by your role' })),
    );
  }

  static rateLimited(detail: string): AppError {
    return new AppError('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS, 'Too many requests', detail);
  }

  static internal(detail?: string): AppError {
    return new AppError(
      'INTERNAL_ERROR',
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Internal server error',
      detail,
    );
  }
}

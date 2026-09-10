import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { PROBLEM_CONTENT_TYPE, type ErrorCode, type ProblemDetails } from '@audit5s/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { getRequestId } from '../observability/request-context';

/**
 * Renders every failure as RFC 7807 `application/problem+json` (ARCHITECTURE.md §8.1).
 *
 * Two rules it exists to keep:
 *   - an unexpected error never leaks its message, stack or SQL to the client; it becomes
 *     a generic INTERNAL_ERROR carrying only the request ID, which correlates to the log;
 *   - every response carries a stable `code`, so clients never parse prose.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = getRequestId() ?? 'unknown';

    const problem = this.toProblem(exception, requestId);

    if (problem.status >= 500) {
      this.logger.error(
        { requestId, method: request.method, url: request.url, err: exception },
        'Unhandled error',
      );
    }

    void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  }

  private toProblem(exception: unknown, requestId: string): ProblemDetails {
    if (exception instanceof AppError) {
      return {
        type: `https://audit5s.dev/problems/${exception.code.toLowerCase()}`,
        title: exception.title,
        status: exception.getStatus(),
        ...(exception.detail ? { detail: exception.detail } : {}),
        code: exception.code,
        requestId,
        ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
      };
    }

    if (exception instanceof ZodError) {
      return {
        type: 'https://audit5s.dev/problems/validation_failed',
        title: 'Validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        requestId,
        errors: exception.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: `https://audit5s.dev/problems/${this.codeForStatus(status).toLowerCase()}`,
        title: exception.message,
        status,
        code: this.codeForStatus(status),
        requestId,
      };
    }

    // Anything else is a bug. The client learns nothing beyond the correlation ID.
    return {
      type: 'https://audit5s.dev/problems/internal_error',
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      requestId,
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return 'TOKEN_INVALID';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_FAILED';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
    }
  }
}

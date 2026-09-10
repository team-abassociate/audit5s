import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../../common/errors';

/**
 * Validates a request body against a schema from `@audit5s/contracts`.
 *
 * The schema is the *same object* the web and mobile clients validate with, so "it synced
 * then got rejected" cannot happen from a shape mismatch (STACK.md §3).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppError.validation(
        'The request body did not match the expected shape',
        result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}

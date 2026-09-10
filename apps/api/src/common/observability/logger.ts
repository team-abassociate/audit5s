import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { getRequestId } from './request-context';

/**
 * Structured logging with PII redaction (§12.15).
 *
 * The redaction list is not decoration: presigned URLs, phone numbers and tokens all pass
 * through this process, and a log line is the easiest place to leak one. `X-Amz-Signature`
 * in particular is stripped, because a presigned URL in a log is a live credential.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/("?(?:password|newPassword|currentPassword)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1"[redacted]"'],
  [/("?(?:refreshToken|accessToken|token|codeHash|code)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1"[redacted]"'],
  [/X-Amz-Signature=[^&\s"]+/gi, 'X-Amz-Signature=[redacted]'],
  [/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]'],
  [/\+\d{10,15}\b/g, '[phone]'],
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function redact(message: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), message);
}

export class StructuredLogger extends ConsoleLogger {
  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    ...rest: unknown[]
  ): string {
    const line = JSON.stringify({
      level: logLevel,
      time: new Date().toISOString(),
      requestId: getRequestId() ?? null,
      context: this.context ?? null,
      message: typeof message === 'string' ? message : safeStringify(message),
    });
    void rest;
    return `${redact(line)}\n`;
  }
}

function safeStringify(value: unknown): string {
  // JSON.stringify(new Error('boom')) is '{}' — message and stack are non-enumerable.
  // Serialising them explicitly is the difference between a diagnosable log and a log
  // that says nothing at all.
  if (value instanceof Error) {
    // Drivers wrap the useful message in `cause` — without it a query failure reads as
    // "Failed query: <sql>" and never says *why*.
    const cause = value.cause instanceof Error ? ` | cause: ${value.cause.message}` : '';
    return `${value.name}: ${value.message}${cause}${value.stack ? `\n${value.stack}` : ''}`;
  }
  try {
    return JSON.stringify(value, errorAwareReplacer) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorAwareReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: value.cause instanceof Error ? value.cause.message : undefined,
      stack: value.stack,
    };
  }
  return value;
}

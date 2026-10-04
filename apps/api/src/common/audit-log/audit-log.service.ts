import { Injectable, Logger } from '@nestjs/common';
import type { AuditLogAction } from '@audit5s/contracts';
import { getRequestContext } from '../observability/request-context';
import { AuditLogRepository, type AuditLogRow } from './audit-log.repository';

export interface AuditLogInput {
  action: AuditLogAction;
  resourceType: string;
  resourceId?: string | null;
  unitId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Writes `audit_log` (ARCHITECTURE.md §5.9).
 *
 * Actor identity is snapshotted as a label, so a later rename does not obscure history,
 * and diffs are redacted before they are stored — a password hash or a token in a diff
 * would turn the audit trail into a secondary credential store (§12.12).
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly repository: AuditLogRepository) {}

  async record(input: AuditLogInput, actorLabel?: string): Promise<void> {
    await this.repository.insert(auditLogRow(input, actorLabel));
  }

  /** Never let an audit-log failure mask the operation's own outcome — but never lose it silently either. */
  async recordSafely(input: AuditLogInput, actorLabel?: string): Promise<void> {
    try {
      await this.record(input, actorLabel);
    } catch (error) {
      this.logger.error({ err: error, action: input.action }, 'Failed to write audit log entry');
    }
  }
}

/**
 * The row for an entry, from the request's actor. Exported for the few writes that must
 * share their domain write's transaction (the sync path, D11): they insert this on `tx`.
 */
export function auditLogRow(input: AuditLogInput, actorLabel?: string): AuditLogRow {
  const context = getRequestContext();
  const actor = context?.actor ?? null;
  return {
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    actorLabel: actorLabel ?? context?.actorLabel ?? 'system',
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    unitId: input.unitId ?? null,
    before: redactDiff(input.before),
    after: redactDiff(input.after),
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,
    deviceId: actor?.deviceId ?? null,
    requestId: context?.requestId ?? 'system',
  };
}

/** Fields that must never reach the audit log, whatever a caller passes (§12.12). */
const FORBIDDEN_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'newpassword',
  'currentpassword',
  'token',
  'tokenhash',
  'token_hash',
  'refreshtoken',
  'accesstoken',
  'codehash',
  'code_hash',
  'pushtoken',
  'push_token',
]);

export function redactDiff(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(redactDiff);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) =>
        FORBIDDEN_KEYS.has(key.toLowerCase()) ? [key, '[redacted]'] : [key, redactDiff(inner)],
      ),
    );
  }
  return value;
}

import { describe, expect, it } from 'vitest';
import { listAuditLogQuerySchema } from './audit-log';

describe('Activity log filters (L1)', () => {
  it('takes one record kind or several, and nothing that is not a kind', () => {
    expect(listAuditLogQuerySchema.parse({ resourceType: 'checklist_template,checklist_version' }).resourceType).toBe(
      'checklist_template,checklist_version',
    );
    expect(listAuditLogQuerySchema.safeParse({ resourceType: 'sync_conflict' }).success).toBe(true);
    expect(listAuditLogQuerySchema.safeParse({ resourceType: "user' OR 1=1" }).success).toBe(false);
    expect(listAuditLogQuerySchema.safeParse({ resourceType: 'user,' }).success).toBe(false);
  });
});

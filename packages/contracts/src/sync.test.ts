import { describe, expect, it } from 'vitest';
import { listSyncConflictsQuerySchema, syncConflictSchema, syncHeldLogSchema, syncUploadLogSchema } from './sync';
import { AUDIT_LOG_ACTIONS } from './audit-log';

const id = '00000000-0000-4000-8000-000000000001';

describe('held-item filters (S3x)', () => {
  it('accepts person, Unit and reason, and refuses what is not one', () => {
    expect(listSyncConflictsQuerySchema.parse({ userId: id, unitId: id, reason: 'DEVICE_NOT_OWNER' })).toMatchObject({
      userId: id,
      unitId: id,
      reason: 'DEVICE_NOT_OWNER',
      resolved: false,
    });
    expect(listSyncConflictsQuerySchema.safeParse({ unitId: 'pune' }).success).toBe(false);
    expect(listSyncConflictsQuerySchema.safeParse({ reason: 'SQL' }).success).toBe(false);
  });
});

describe('held item context (F4)', () => {
  const row = {
    id,
    deviceId: null,
    userId: id,
    userName: 'Asha',
    entityType: 'question_response',
    entityId: id,
    reason: 'AUDIT_ALREADY_COMPLETED',
    detail: null,
    incomingPayload: {},
    existingPayload: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolution: null,
    createdAt: '2026-10-05T10:00:00.000Z',
  };

  it('carries the Unit, audit and Zone, null where unknown', () => {
    expect(syncConflictSchema.safeParse(row).success).toBe(false);
    const withContext = { ...row, unitId: id, unitName: 'Pune', auditId: id, zoneLabel: 'Zone 2 — Press' };
    expect(syncConflictSchema.parse(withContext)).toEqual(withContext);
    expect(
      syncConflictSchema.safeParse({ ...row, unitId: null, unitName: null, auditId: null, zoneLabel: null }).success,
    ).toBe(true);
  });
});

describe('upload entries in the Activity log (D11)', () => {
  it('are logged actions', () => {
    expect(AUDIT_LOG_ACTIONS).toContain('sync.batch_received');
    expect(AUDIT_LOG_ACTIONS).toContain('sync.item_held');
    expect(AUDIT_LOG_ACTIONS).toContain('audit.restarted');
  });

  it('count a batch and name a held item', () => {
    const upload = { batchId: id, appVersion: null, items: 3, applied: 2, held: 1, waiting: 0, photos: 1, auditIds: [id] };
    expect(syncUploadLogSchema.parse(upload)).toEqual(upload);
    expect(syncUploadLogSchema.safeParse({ ...upload, held: -1 }).success).toBe(false);
    const held = { batchId: id, entityType: 'evidence', reason: 'SCOPE_REVOKED', detail: null, auditId: null, zoneLabel: null };
    expect(syncHeldLogSchema.parse(held)).toEqual(held);
  });
});

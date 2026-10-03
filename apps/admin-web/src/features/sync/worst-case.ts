import type { Device, Page, SyncConflict } from '@audit5s/contracts';
import { HINDI_ZONE, LONG_PERSON, LONG_UNIT, uuid } from '@/features/audit-log/worst-case';

/** Dev-only worst case for Sync health (`?data=worst`): 1,000 held items over 1 / 3 / 0 phones. */
const REASONS = [
  'AUDIT_ALREADY_COMPLETED',
  'DEVICE_NOT_OWNER',
  'CHECKLIST_VERSION_MISMATCH',
  'SCOPE_REVOKED',
  'VALIDATION_FAILED',
] as const;
const ENTITIES = ['question_response', 'audit_zone', 'evidence', 'audit', 'corrective_action_submission'];

export function worstConflicts(resolved: boolean): Page<SyncConflict> {
  const data = Array.from({ length: 1000 }, (_, i): SyncConflict => ({
    id: uuid(i),
    deviceId: i % 7 === 0 ? null : uuid(100 + (i % 3)),
    userId: uuid(200 + (i % 4)),
    userName: i % 4 === 0 ? null : i % 2 ? LONG_PERSON : 'A',
    entityType: ENTITIES[i % ENTITIES.length]!,
    entityId: uuid(300 + i),
    reason: REASONS[i % REASONS.length]!,
    detail:
      i % 3 === 0
        ? null
        : `The audit at ${LONG_UNIT} was already finished when this answer for ${HINDI_ZONE} arrived from the device.`,
    incomingPayload: {
      value: i % 2 ? 'SCORE_1' : 'NA',
      remark: i % 5 ? 'टूटा हुआ रैक; ' + 'बहुत लंबी टिप्पणी '.repeat(20) : '',
      answeredAt: '2026-09-21T15:17:52.539Z',
      checklistQuestionId: uuid(9),
      photoCount: 1284,
    },
    existingPayload: i % 2 ? { id: uuid(400 + i), value: 'SCORE_2', remark: null } : null,
    resolvedAt: resolved ? '2026-09-30T09:00:00.000Z' : null,
    resolvedByUserId: resolved ? uuid(1) : null,
    resolution: resolved ? (i % 2 ? 'APPLY' : 'DISCARD') : null,
    createdAt: new Date(Date.UTC(2026, 8, 30, 9, 0) - i * 1_800_000).toISOString(),
  }));
  return { data, nextCursor: null };
}

export function worstDevices(): Page<Device> {
  const base = {
    userId: uuid(200),
    platform: 'android',
    osVersion: '14',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as const;
  const people = Array.from({ length: 9 }, (_, i) => ({
    userId: uuid(500 + i),
    fullName: i % 2 ? LONG_PERSON : 'A',
    lastSignedInAt: '2026-09-28T09:00:00.000Z',
    revokedAt: i === 3 ? '2026-09-29T09:00:00.000Z' : null,
  }));
  const data: Device[] = [
    { ...base, id: uuid(100), people, model: `Samsung Galaxy A14 5G (${LONG_UNIT} stores)`, appVersion: '1.12.0-rc.3+build.20260930', lastSeenAt: '2026-09-20T09:00:00.000Z', lastSyncAt: '2026-09-20T09:00:00.000Z', revokedAt: null },
    { ...base, id: uuid(101), people: [], model: null, appVersion: null, lastSeenAt: null, lastSyncAt: null, revokedAt: null },
    { ...base, id: uuid(102), people: people.slice(0, 1), model: 'Redmi', appVersion: '1.0.0', lastSeenAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), revokedAt: '2026-09-29T09:00:00.000Z' },
  ];
  return { data, nextCursor: null };
}

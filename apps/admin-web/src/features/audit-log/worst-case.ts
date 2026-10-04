import { AUDIT_LOG_ACTIONS, type AuditLogEntry, type Page } from '@audit5s/contracts';

/**
 * Dev-only worst case for the Activity log (`?data=worst`, read only under
 * `import.meta.env.DEV`): 1,000 entries, the longest names we have seen, Hindi Zone names,
 * every action, unbreakable strings. Never shipped: every call sits behind `isWorstCase()`,
 * which is false outside a dev build.
 */
export const isWorstCase = () =>
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';

export const LONG_UNIT = 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd';
export const LONG_PERSON =
  'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
export const HINDI_ZONE = 'भंडार क्षेत्र — कच्चा माल (उत्तरी गोदाम)';

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The upload entries' own shapes (D11), so their chips render at worst-case sizes too. */
const SYNC_AFTER: Partial<Record<string, (i: number) => object>> = {
  'sync.batch_received': (i) => ({
    batchId: uuid(i),
    appVersion: '0.1.0',
    items: 100,
    applied: 1284,
    held: i % 2 ? 37 : 0,
    waiting: 12,
    photos: 25,
    auditIds: [uuid(2)],
  }),
  'sync.item_held': (i) => ({
    batchId: uuid(i),
    entityType: 'question_response',
    reason: 'AUDIT_ALREADY_COMPLETED',
    detail: null,
    auditId: uuid(2),
    zoneLabel: `Zone 12 — ${HINDI_ZONE}`,
  }),
};

export function worstAuditLog(): Page<AuditLogEntry> {
  const data = Array.from({ length: 1000 }, (_, i): AuditLogEntry => {
    const action = AUDIT_LOG_ACTIONS[i % AUDIT_LOG_ACTIONS.length]!;
    return {
      id: String(i),
      actorUserId: uuid(i % 7),
      actorRole: i % 3 === 0 ? 'SUPER_ADMIN' : 'COORDINATOR',
      actorLabel: i % 2 ? LONG_PERSON : 'A',
      action,
      resourceType: action.split('.')[0]!,
      resourceId: uuid(i),
      unitId: uuid(1),
      before:
        i % 4 === 0
          ? null
          : { name: i % 5 ? HINDI_ZONE : LONG_UNIT, status: 'IN_PROGRESS', value: 'SCORE_1', zoneLeaderId: null },
      after: SYNC_AFTER[action]?.(i) ?? {
        name: i % 5 ? `${HINDI_ZONE} (renamed)` : LONG_UNIT,
        status: 'COMPLETED',
        value: 'SCORE_2',
        completedAt: '2026-09-21T15:17:52.539Z',
        note: 'x'.repeat(240),
        zoneLeaderId: uuid(9),
        count: 1284,
      },
      ipAddress: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A.231005.007; wv) AppleWebKit/537.36',
      deviceId: null,
      requestId: `req-${'0'.repeat(60)}${i}`,
      occurredAt: new Date(Date.UTC(2026, 8, 30, 9, 0) - i * 3_600_000).toISOString(),
    };
  });
  return { data, nextCursor: null };
}

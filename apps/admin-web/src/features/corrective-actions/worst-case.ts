import { S_SECTIONS } from '@audit5s/contracts';
import {
  CORRECTIVE_ACTION_STATUSES,
  type CorrectiveActionSummary,
} from '@audit5s/contracts';
import type {
  Audit,
  CorrectiveAction,
  CorrectiveActionDetail,
  CorrectiveActionStatus,
  Page,
  Unit,
  Zone,
} from '@audit5s/contracts';

/**
 * Development only (`?data=worst`, read only under `import.meta.env.DEV`): the worst data the
 * corrective-action queue can be handed — the longest Unit, Zone and leader names, Devanagari
 * Zones and leaders, Zones with no leader on record, 1,000 actions, and no Zone Leader
 * accounts to reassign to. "Submitted" matches nothing, for the empty state.
 */

const id = (kind: number, n: number) => `00000000-0000-7000-8${kind}00-${String(n).padStart(12, '0')}`;
const page = <T>(data: T[]): Page<T> => ({ data, nextCursor: null }) as unknown as Page<T>;
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const LONG_UNIT = 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd';
const LONG_LEADER = 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
const units = [LONG_UNIT, 'Nashik'].map((name, index) => ({ id: id(1, index), name }) as Unit);

const ZONE_NAMES = [
  'Zone 1',
  'भंडार कक्ष (कच्चा माल) — पूर्वी गोदाम',
  'Heat treatment, induction hardening and shot-blasting line No. 3 (night shift)',
  'Zone 4',
  'असेंबली लाइन',
  'Dispatch',
];
const LEADERS = [LONG_LEADER, 'अमोल खैरनार', null, 'A', null, 'Priyadarshini Ramachandran'];

const zones: Zone[] = units.flatMap((unit, u) =>
  Array.from({ length: 24 }, (_, z) => ({
    id: id(2, u * 100 + z),
    unitId: unit.id,
    code: `Z-${String(z + 1).padStart(2, '0')}`,
    name: ZONE_NAMES[z % ZONE_NAMES.length]!,
    description: null,
    departmentHint: null,
    defaultChecklistTemplateId: null,
    zoneLeaderId: null,
    zoneLeaderName: LEADERS[z % LEADERS.length]!,
    sortOrder: z,
    version: 1,
    archivedAt: null,
    createdAt: at(-90),
    updatedAt: at(-90),
  })),
);

const audits = units.flatMap((unit, u) =>
  [60, 30, 9].map(
    (ago, a) =>
      ({
        id: id(3, u * 10 + a),
        unitId: unit.id,
        completedAt: at(-ago),
        auditorName: a === 1 ? LONG_LEADER : 'Local Consultant',
      }) as Audit,
  ),
);

const STATUSES: CorrectiveActionStatus[] = ['OPEN', 'OPEN', 'REOPENED', 'NOT_POSSIBLE', 'VERIFIED', 'WITHDRAWN', 'OPEN'];
const QUESTION =
  'Only materials, tools and fixtures required for the current shift are kept at the workstation; ' +
  'everything else is red-tagged, recorded in the register and moved to the holding area within 48 hours';

const actions: CorrectiveAction[] = Array.from({ length: 1000 }, (_, n) => {
  const u = n % 7 === 0 ? 1 : 0;
  const zone = zones[u * 24 + (n % 24)]!;
  const audit = audits[u * 3 + (n % 3)]!;
  const status = STATUSES[n % STATUSES.length]!;
  const overall = n % 11 === 0;
  const walkBy = !overall && n % 13 === 0;
  return {
    id: id(4, n),
    evidenceId: overall ? null : id(5, n),
    suggestion: overall ? `${QUESTION}. ${QUESTION}.` : null,
    suggestionNo: overall ? (n % 20) + 1 : null,
    auditId: audit.id,
    auditZoneId: id(6, n),
    unitId: zone.unitId,
    zoneId: zone.id,
    checklistQuestionId: overall || walkBy ? null : id(7, n % 25),
    status,
    assignedZoneLeaderUserId: null,
    // One reassigned to a named account; the rest fall back to the Zone's leader.
    assignedZoneLeaderName: n === 3 ? 'Reassigned Leader' : null,
    zoneLeaderName: zone.zoneLeaderName,
    dueAt: n % 17 === 0 ? null : at((n % 9) * 3 - 14),
    openedAt: at(-((n * 7) % 120)),
    lastSubmittedAt: null,
    resolvedAt: status === 'VERIFIED' ? at(-1) : null,
    verifiedByUserId: status === 'VERIFIED' && n % 2 === 0 ? id(8, 1) : null,
    verifiedByName: status === 'VERIFIED' && n % 2 === 0 ? LONG_LEADER : null,
    closedByName: status === 'VERIFIED' ? LONG_LEADER : null,
    reopenCount: status === 'REOPENED' ? 1284 : 0,
    version: 1,
    auditType: n % 2 ? 'EXTERNAL_5S' : 'INTERNAL_5S',
    auditorUserId: id(8, 2),
    auditorName: audit.auditorName,
    zoneCode: zone.code,
    zoneName: zone.name,
    section: overall || walkBy ? null : S_SECTIONS[n % 5]!,
    questionGlobalOrder: overall || walkBy ? null : (n % 25) + 1,
    questionText: overall || walkBy ? null : QUESTION,
    scoreAtCapture: null,
    findingRemark: n % 3 ? null : `${QUESTION}. ${QUESTION}.`,
    auditCompletedAt: audit.completedAt,
  } as CorrectiveAction;
});

function detail(action: CorrectiveAction): CorrectiveActionDetail {
  const attempts = action.status === 'OPEN' ? 0 : action.status === 'REOPENED' ? 2 : 1;
  return {
    ...action,
    submissions: Array.from({ length: attempts }, (_, a) => ({
      id: id(9, a),
      correctiveActionId: action.id,
      attemptNo: a + 1,
      option: action.status === 'NOT_POSSIBLE' || a === 0 ? 'NOT_POSSIBLE' : 'COMPLETED',
      submittedByUserId: id(8, 3),
      submittedByName: LONG_LEADER,
      description: `${QUESTION}.`,
      explanation: `${QUESTION}. ${QUESTION}.`,
      afterEvidenceId: null,
      submittedVia: a ? 'MOBILE' : 'WEB_TOKEN',
      reviewOutcome: action.status === 'REOPENED' && a === 0 ? 'REOPENED' : null,
      reviewedByUserId: null,
      reviewedByName: action.status === 'REOPENED' && a === 0 ? LONG_LEADER : null,
      reviewedByRole: action.status === 'REOPENED' && a === 0 ? 'COORDINATOR' : null,
      reviewedAt: action.status === 'REOPENED' && a === 0 ? at(-2) : null,
      reviewComment: action.status === 'REOPENED' && a === 0 ? `${QUESTION}.` : null,
      createdAt: at(-3 + a),
    })),
  } as CorrectiveActionDetail;
}

export function worstCase(path: string): unknown {
  const [route = '', query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (route === '/units') return page(units);
  if (route === '/users') return page([]);
  if (route === '/audits') return page(audits.filter((audit) => audit.unitId === params.get('unitId')));
  const zonesOf = /^\/units\/([^/]+)\/zones$/.exec(route);
  if (zonesOf) return page(zones.filter((zone) => zone.unitId === zonesOf[1]));
  if (route === '/corrective-actions' || route === '/corrective-actions/summary') {
    const now = Date.now();
    const matching = actions.filter(
      (action) =>
        (!params.get('status') || action.status === params.get('status')) &&
        (params.get('awaitingReview') !== 'true' || action.status === 'ACTION_SUBMITTED' || action.status === 'NOT_POSSIBLE') &&
        (!params.get('unitId') || action.unitId === params.get('unitId')) &&
        (!params.get('auditId') || action.auditId === params.get('auditId')) &&
        (params.get('overdue') !== 'true' || late(action, now)),
    );
    if (route === '/corrective-actions/summary') return summarize(matching, now);
    // The server's order (CA10) and its cursor: the id of the last row handed out.
    const sorted = matching.sort((a, b) => compare(orderKeys(a, params), orderKeys(b, params)));
    const start = params.get('cursor') ? sorted.findIndex((a) => a.id === params.get('cursor')) + 1 : 0;
    const limit = Number(params.get('limit') ?? 50);
    const data = sorted.slice(start, start + limit);
    return { data, nextCursor: start + limit < sorted.length ? data.at(-1)!.id : null };
  }
  const one = /^\/corrective-actions\/([^/]+)$/.exec(route);
  const found = one && actions.find((action) => action.id === one[1]);
  if (found) return detail(found);
  throw new Error(`No worst-case fixture for ${path}`);
}

const live = (a: CorrectiveAction) => a.status === 'OPEN' || a.status === 'REOPENED';
const late = (a: CorrectiveAction, now: number) => live(a) && a.dueAt !== null && Date.parse(a.dueAt) < now;
const chase = (a: CorrectiveAction) => a.assignedZoneLeaderName ?? a.zoneLeaderName ?? null;

/** The server's order keys (`orderKeys` in the API's repository), for the fixture to page. */
function orderKeys(a: CorrectiveAction, params: URLSearchParams): Array<string | number> {
  const leader = [chase(a) === null ? 1 : 0, chase(a) ?? ''];
  const due = a.dueAt ?? '9999';
  const group = params.get('group');
  const groupKeys =
    group === 'audit'
      ? [a.unitId, -Date.parse(a.auditCompletedAt ?? '1970-01-01'), a.auditId]
      : group === 'leader'
        ? [a.unitId, a.zoneCode, a.zoneId, ...leader]
        : [];
  const sort = params.get('sort');
  const sortKeys = sort === 'age' ? [a.openedAt] : sort === 'leader' ? [...leader, live(a) ? 0 : 1, due] : [live(a) ? 0 : 1, due];
  return [...groupKeys, ...sortKeys, a.id];
}

function compare(a: Array<string | number>, b: Array<string | number>): number {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function summarize(rows: CorrectiveAction[], now: number): CorrectiveActionSummary {
  const count = (keep: (a: CorrectiveAction) => boolean) => rows.filter(keep).length;
  const grouped = <K extends string>(key: (a: CorrectiveAction) => K) => {
    const groups = new Map<K, CorrectiveAction[]>();
    for (const a of rows) groups.set(key(a), [...(groups.get(key(a)) ?? []), a]);
    return [...groups.values()];
  };
  const counts = (list: CorrectiveAction[]) => ({ total: list.length, overdue: list.filter((a) => late(a, now)).length });
  return {
    total: rows.length,
    byStatus: Object.fromEntries(CORRECTIVE_ACTION_STATUSES.map((s) => [s, count((a) => a.status === s)])) as CorrectiveActionSummary['byStatus'],
    overdue: count((a) => late(a, now)),
    dueWithinWeek: count((a) => live(a) && a.dueAt !== null && Date.parse(a.dueAt) >= now && Date.parse(a.dueAt) < now + 7 * DAY),
    openNeedsImprovement: count((a) => live(a) && a.scoreAtCapture === 'SCORE_0'),
    byAudit: grouped((a) => a.auditId).map((list) => ({ unitId: list[0]!.unitId, auditId: list[0]!.auditId, ...counts(list) })),
    byZoneLeader: grouped((a) => `${a.zoneId}|${chase(a) ?? ''}`).map((list) => ({
      unitId: list[0]!.unitId,
      zoneId: list[0]!.zoneId,
      zoneCode: list[0]!.zoneCode,
      zoneName: list[0]!.zoneName,
      leader: chase(list[0]!),
      ...counts(list),
    })),
  };
}

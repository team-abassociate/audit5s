import { S_SECTIONS } from '@audit5s/contracts';
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
  if (route === '/corrective-actions') {
    const now = Date.now();
    return page(
      actions.filter(
        (action) =>
          (!params.get('status') || action.status === params.get('status')) &&
          (!params.get('unitId') || action.unitId === params.get('unitId')) &&
          (!params.get('auditId') || action.auditId === params.get('auditId')) &&
          (params.get('overdue') !== 'true' ||
            ((action.status === 'OPEN' || action.status === 'REOPENED') &&
              action.dueAt !== null &&
              Date.parse(action.dueAt) < now)),
      ),
    );
  }
  const one = /^\/corrective-actions\/([^/]+)$/.exec(route);
  const found = one && actions.find((action) => action.id === one[1]);
  if (found) return detail(found);
  throw new Error(`No worst-case fixture for ${path}`);
}

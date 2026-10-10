import { describe, expect, it } from 'vitest';
import {
  departmentKey,
  formatRupees,
  inKaizenPeriod,
  kaizenAnalysis,
  kaizenDashboard,
  kaizenFunnel,
  kaizenKpi,
  kaizenRatioPct,
  kaizenTopDepartments,
  kaizenTrend,
  lastSixMonths,
  missingKaizenFields,
  missingKaizenItems,
  topApprovedBySaving,
  type KaizenFact,
} from './kaizen';
import { canTransition, nextStatuses } from './state-machine';
import { formatScore } from './scoring';
import { findPermission, grantFor } from './permission-matrix';

// 7 Oct 2026, 4 PM IST.
const NOW = new Date('2026-10-07T10:30:00Z');

function fact(overrides: Partial<KaizenFact> = {}): KaizenFact {
  return {
    status: 'SUBMITTED',
    submittedAt: '2026-10-02T05:00:00Z',
    approvedAt: null,
    reviewed: false,
    annualSaving: null,
    department: 'Assembly',
    zoneId: 'z1',
    zoneName: 'Press',
    zoneCode: 'Z-01',
    ...overrides,
  };
}

const approved = (overrides: Partial<KaizenFact> = {}) =>
  fact({ status: 'APPROVED', reviewed: true, approvedAt: '2026-10-05T05:00:00Z', ...overrides });

describe('the Kaizen state machine', () => {
  it('lets a Zone Leader submit a complete sheet, and resubmit one sent back', () => {
    const complete = { role: 'ZONE_LEADER' as const, satisfied: ['kaizen_sheet_complete' as const] };
    expect(canTransition('kaizen', 'DRAFT', 'SUBMITTED', complete).allowed).toBe(true);
    expect(canTransition('kaizen', 'SENT_BACK', 'SUBMITTED', complete).allowed).toBe(true);
    expect(canTransition('kaizen', 'DRAFT', 'SUBMITTED', { role: 'ZONE_LEADER' })).toEqual({
      allowed: false,
      reason: 'GUARD_UNMET',
      guard: 'kaizen_sheet_complete',
    });
  });

  it('lets only a Coordinator (or Super Admin) decide, with a reason to send back or reject', () => {
    expect(canTransition('kaizen', 'SUBMITTED', 'APPROVED', { role: 'COORDINATOR' }).allowed).toBe(true);
    expect(canTransition('kaizen', 'SUBMITTED', 'APPROVED', { role: 'ZONE_LEADER' }).allowed).toBe(false);
    expect(canTransition('kaizen', 'SUBMITTED', 'APPROVED', { role: 'CONSULTANT' }).allowed).toBe(false);
    expect(canTransition('kaizen', 'SUBMITTED', 'APPROVED', { role: 'SUPER_ADMIN' }).allowed).toBe(true);
    expect(canTransition('kaizen', 'SUBMITTED', 'REJECTED', { role: 'COORDINATOR' }).allowed).toBe(false);
    expect(
      canTransition('kaizen', 'SUBMITTED', 'SENT_BACK', {
        role: 'COORDINATOR',
        satisfied: ['reason_given'],
      }).allowed,
    ).toBe(true);
  });

  it('ends at APPROVED and REJECTED, and has no edge out of them', () => {
    for (const role of ['ZONE_LEADER', 'COORDINATOR', 'SUPER_ADMIN'] as const) {
      expect(nextStatuses('kaizen', 'APPROVED', role)).toEqual([]);
      expect(nextStatuses('kaizen', 'REJECTED', role)).toEqual([]);
    }
    expect(nextStatuses('kaizen', 'SUBMITTED', 'COORDINATOR')).toEqual(['APPROVED', 'SENT_BACK', 'REJECTED']);
    expect(nextStatuses('kaizen', 'SUBMITTED', 'ZONE_LEADER')).toEqual([]);
  });
});

describe('Kaizen permissions', () => {
  it('shows a Zone Leader their own, a Coordinator the Unit, and lets only a Coordinator review', () => {
    expect(grantFor('ZONE_LEADER', 'kaizen:read')?.resolver).toBe('own_record');
    expect(grantFor('COORDINATOR', 'kaizen:read')?.resolver).toBe('own_unit');
    expect(grantFor('CONSULTANT', 'kaizen:read')?.resolver).toBe('assigned_units');
    expect(grantFor('COORDINATOR', 'kaizen:review')?.resolver).toBe('own_unit');
    expect(grantFor('ZONE_LEADER', 'kaizen:review')).toBeNull();
    expect(grantFor('CONSULTANT', 'kaizen:create')).toBeNull();
    expect(grantFor('COORDINATOR', 'kaizen:create')).toBeNull();
    // R-18, through the rule rather than a cell.
    expect(findPermission('kaizen:review')?.grants.SUPER_ADMIN?.resolver).toBe('organization');
  });
});

describe('missingKaizenFields', () => {
  it('names every empty required step in form order, and takes "No" as an answer', () => {
    expect(missingKaizenFields({ machine: '  ', theme: 'x', horizontalDeployment: false })).toEqual([
      'machine',
      'lineArea',
      'implementedOn',
      'teamMembers',
      'problem5w1h',
      'countermeasure',
      'benefits',
      'rootCause4m',
      'ideaBy',
      'implementedBy',
    ]);
  });
});

describe('missingKaizenItems', () => {
  const full = {
    machine: 'Press 4',
    lineArea: 'Line 2',
    implementedOn: '2026-10-01',
    teamMembers: 'Ravi',
    theme: 'Faster changeover',
    problem5w1h: 'Slow',
    countermeasure: 'Clamps',
    horizontalDeployment: false,
    benefits: 'Fast',
    rootCause4m: 'Method',
    ideaBy: 'Ravi',
    implementedBy: 'Sita',
  };

  it('adds the missing photos after the fields, before first', () => {
    expect(missingKaizenItems({ ...full, machine: '' }, { before: false, after: false })).toEqual([
      'machine',
      'beforePhoto',
      'afterPhoto',
    ]);
    expect(missingKaizenItems(full, { before: true, after: false })).toEqual(['afterPhoto']);
  });

  it('is empty for a full sheet with both photos', () => {
    expect(missingKaizenItems(full, { before: true, after: true })).toEqual([]);
  });
});

describe('periods', () => {
  it('reads the month in IST: 1 AM IST on 1 Nov is November', () => {
    expect(inKaizenPeriod('2026-10-31T19:30:00Z', 'month', new Date('2026-11-05T00:00:00Z'))).toBe(true);
    expect(inKaizenPeriod('2026-10-31T18:00:00Z', 'month', new Date('2026-11-05T00:00:00Z'))).toBe(false);
    expect(inKaizenPeriod('2026-01-03T00:00:00Z', 'year', NOW)).toBe(true);
    expect(inKaizenPeriod('2025-12-30T00:00:00Z', 'year', NOW)).toBe(false);
    expect(inKaizenPeriod('2019-01-01T00:00:00Z', 'overall', NOW)).toBe(true);
  });

  it('runs six months back across a year end', () => {
    expect(lastSixMonths(new Date('2026-02-10T00:00:00Z'))).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });
});

describe('A. the KPI card', () => {
  it('counts by status, never a DRAFT, and divides by submitted', () => {
    const kpi = kaizenKpi(
      [
        fact({ status: 'DRAFT', submittedAt: null }),
        fact(),
        fact({ status: 'SENT_BACK', reviewed: true }),
        fact({ status: 'REJECTED', reviewed: true }),
        approved(),
        approved({ submittedAt: '2026-08-01T00:00:00Z' }),
      ],
      'month',
      NOW,
    );
    expect(kpi).toEqual({
      submitted: 4,
      awaitingReview: 1,
      sentBack: 1,
      rejected: 1,
      approved: 1,
      rejectionRatioPct: 25,
      acceptanceRatioPct: 25,
    });
  });

  it('has no ratio when nothing was submitted, and never rounds one up', () => {
    const empty = kaizenKpi([fact({ status: 'DRAFT', submittedAt: null })], 'overall', NOW);
    expect(empty.rejectionRatioPct).toBeNull();
    expect(empty.acceptanceRatioPct).toBeNull();
    expect(formatScore(kaizenRatioPct(2, 3)!)).toBe('66.6');
  });
});

describe('B. the funnel', () => {
  it('narrows stage by stage; a resubmitted Kaizen still counts as reviewed', () => {
    const funnel = kaizenFunnel(
      [
        fact(),
        fact({ reviewed: true }), // sent back once, resubmitted, waiting again
        fact({ status: 'REJECTED', reviewed: true }),
        approved({ annualSaving: 0 }),
        approved({ annualSaving: 108000 }),
      ],
      'overall',
      NOW,
    );
    expect(funnel.map((stage) => [stage.stage, stage.count, stage.pctOfSubmitted])).toEqual([
      ['SUBMITTED', 5, 100],
      ['REVIEWED', 4, 80],
      ['APPROVED', 2, 40],
      ['APPROVED_WITH_SAVING', 1, 20],
    ]);
  });

  it('keeps every stage at zero with no percentage when empty', () => {
    expect(kaizenFunnel([], 'overall', NOW).every((s) => s.count === 0 && s.pctOfSubmitted === null)).toBe(
      true,
    );
  });
});

describe('C. the trend', () => {
  it('has six months with no gaps; approvals land in their review month', () => {
    const trend = kaizenTrend(
      [
        fact({ submittedAt: '2026-05-10T00:00:00Z' }),
        approved({ submittedAt: '2026-09-28T00:00:00Z', approvedAt: '2026-10-01T00:00:00Z' }),
        fact({ submittedAt: '2026-03-01T00:00:00Z' }), // before the window
        fact({ status: 'DRAFT', submittedAt: null }),
      ],
      NOW,
    );
    expect(trend).toEqual([
      { month: '2026-05', submitted: 1, approved: 0 },
      { month: '2026-06', submitted: 0, approved: 0 },
      { month: '2026-07', submitted: 0, approved: 0 },
      { month: '2026-08', submitted: 0, approved: 0 },
      { month: '2026-09', submitted: 1, approved: 0 },
      { month: '2026-10', submitted: 0, approved: 1 },
    ]);
  });
});

describe('D. top 5 departments', () => {
  it('groups spellings, labels with the most common one, and keeps "No department" in the race', () => {
    const facts = [
      fact({ department: 'Assembly' }),
      fact({ department: ' assembly ' }),
      fact({ department: 'Assembly' }),
      fact({ department: null }),
      fact({ department: '  ' }),
      fact({ department: 'Paint' }),
      approved({ department: 'Paint' }),
    ];
    const top = kaizenTopDepartments(facts, NOW);
    expect(top.submitted.map((s) => [s.label, s.total])).toEqual([
      ['Assembly', 3],
      ['Paint', 2],
      [null, 2],
    ]);
    expect(top.submitted[0]!.monthly).toEqual([0, 0, 0, 0, 0, 3]);
    expect(top.approved.map((s) => [s.label, s.total])).toEqual([['Paint', 1]]);
  });

  it('keeps five', () => {
    const facts = ['A', 'B', 'C', 'D', 'E', 'F'].map((department) => fact({ department }));
    expect(kaizenTopDepartments(facts, NOW).submitted.map((s) => s.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(kaizenTopDepartments([], NOW)).toEqual({ submitted: [], approved: [] });
  });

  it('folds case and spaces into one key', () => {
    expect(departmentKey('  Paint   Shop ')).toBe('paint shop');
    expect(departmentKey(null)).toBe('');
  });
});

describe('the dashboard', () => {
  it('assembles the four visuals from one set of facts', () => {
    const dashboard = kaizenDashboard([approved({ annualSaving: 500 })], 'year', NOW);
    expect(dashboard.period).toBe('year');
    expect(dashboard.serverTime).toBe(NOW.toISOString());
    expect(dashboard.kpi.acceptanceRatioPct).toBe(100);
    expect(dashboard.funnel[3]!.count).toBe(1);
    expect(dashboard.trend).toHaveLength(6);
    expect(dashboard.topDepartments.approved[0]!.label).toBe('Assembly');
  });
});

describe('the analysis table', () => {
  const facts = [
    approved({ annualSaving: 0.1, zoneId: 'z2', zoneName: 'Paint', zoneCode: 'Z-02', department: 'Paint' }),
    approved({ annualSaving: 0.2, zoneId: 'z2', zoneName: 'Paint', zoneCode: 'Z-02', department: 'Paint' }),
    fact({ status: 'SENT_BACK', reviewed: true }),
    fact({ status: 'REJECTED', reviewed: true }),
    fact(),
    fact({ status: 'DRAFT', submittedAt: null }),
  ];

  it('rolls up by department, adding rupees without float drift', () => {
    expect(kaizenAnalysis(facts, 'department', 'overall', NOW)).toEqual([
      { key: 'assembly', label: 'Assembly', zoneCode: null, total: 3, approved: 0, pending: 1, returned: 2, approvedSaving: 0 },
      { key: 'paint', label: 'Paint', zoneCode: null, total: 2, approved: 2, pending: 0, returned: 0, approvedSaving: 0.3 },
    ]);
  });

  it('rolls up by Zone, and respects the period', () => {
    const rows = kaizenAnalysis(facts, 'zone', 'overall', NOW);
    expect(rows.map((r) => [r.key, r.label, r.zoneCode, r.total])).toEqual([
      ['z1', 'Press', 'Z-01', 3],
      ['z2', 'Paint', 'Z-02', 2],
    ]);
    expect(kaizenAnalysis(facts, 'zone', 'month', new Date('2027-01-01T00:00:00Z'))).toEqual([]);
  });
});

describe('top 3 approved by saving', () => {
  it('takes approved only, largest saving first, newest first among equals', () => {
    const items = [
      { id: 'a', status: 'APPROVED' as const, annualSaving: 100, submittedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', status: 'SUBMITTED' as const, annualSaving: 999, submittedAt: '2026-01-01T00:00:00Z' },
      { id: 'c', status: 'APPROVED' as const, annualSaving: 500, submittedAt: '2026-01-01T00:00:00Z' },
      { id: 'd', status: 'APPROVED' as const, annualSaving: 100, submittedAt: '2026-02-01T00:00:00Z' },
      { id: 'e', status: 'APPROVED' as const, annualSaving: null, submittedAt: null },
    ];
    expect(topApprovedBySaving(items).map((k) => k.id)).toEqual(['c', 'd', 'a']);
  });
});

describe('formatRupees', () => {
  it('groups the Indian way and prints whole rupees', () => {
    expect(formatRupees(0)).toBe('₹0');
    expect(formatRupees(999)).toBe('₹999');
    expect(formatRupees(1000)).toBe('₹1,000');
    expect(formatRupees(108000)).toBe('₹1,08,000');
    expect(formatRupees(12_40_000.49)).toBe('₹12,40,000');
    expect(formatRupees(1_23_45_67_890)).toBe('₹1,23,45,67,890');
    expect(formatRupees(null)).toBe('—');
  });
});

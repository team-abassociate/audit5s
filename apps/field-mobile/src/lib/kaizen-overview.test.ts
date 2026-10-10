import { describe, expect, it } from 'vitest';
import type { KaizenStatus } from '@audit5s/contracts';
import { groupLeaderKaizens } from './kaizen-overview';

const NOW = Date.parse('2026-10-10T06:00:00.000Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const k = (status: KaizenStatus, submittedAt: string | null) => ({ status, submittedAt });

describe('groupLeaderKaizens', () => {
  const all = [
    k('DRAFT', null),
    k('SUBMITTED', day(2)),
    k('SUBMITTED', day(45)),
    k('APPROVED', day(3)),
    k('APPROVED', day(40)),
    k('SENT_BACK', day(50)),
    k('REJECTED', day(1)),
  ];
  const groups = groupLeaderKaizens(all, NOW);

  it('"Needs your fix" is sent back only: a rejected Kaizen is final and needs nobody', () => {
    expect(groups.needsFix.map((x) => x.status)).toEqual(['SENT_BACK']);
  });

  it('"Last 30 days" counts by submittedAt; "Now" counts whatever the date', () => {
    expect(groups.recent).toHaveLength(3);
    expect(groups.approved).toHaveLength(1);
    expect(groups.waiting).toHaveLength(2);
    expect(groups.needsFix).toHaveLength(1);
    expect(groups.drafts).toHaveLength(1);
  });
});

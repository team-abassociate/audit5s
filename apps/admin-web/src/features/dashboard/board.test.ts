import { describe, expect, it } from 'vitest';
import type { Zone, ZoneRankingItem } from '@audit5s/contracts';
import {
  TARGET,
  awaitingRollup,
  bandLabel,
  bandOf,
  delta1,
  mergeBoard,
  score1,
  score2,
  score3,
  trendGeometry,
  type LatestZoneAudit,
} from './board';

const zone = (id: string, code: string, extra: Partial<Zone> = {}): Zone =>
  ({
    id,
    code,
    name: code,
    zoneLeaderName: 'P. Menon',
    archivedAt: null,
    ...extra,
  }) as Zone;

const ranked = (zoneId: string, zoneCode: string, pct: number | null): ZoneRankingItem =>
  ({
    zoneId,
    zoneCode,
    zoneName: zoneCode,
    rank: 1,
    score: { rawScore: 0, maxScore: 0, scorePercentage: pct, sampleCount: 1 },
    lastScore: pct,
    previousScore: null,
    improvement: -2.9,
    auditCount: 1,
    lastAuditAt: '2026-09-09T18:02:00.000Z',
    daysSinceLastAudit: 3,
    dominantWeakSection: null,
    openNonconformities: 5,
  }) as ZoneRankingItem;

describe('band assignment', () => {
  it('follows the four bands of R-6b, collapsed onto the three token colours', () => {
    expect(bandOf(100)).toBe('ok');
    expect(bandOf(90)).toBe('ok');
    expect(bandOf(75)).toBe('ok');
    expect(bandOf(74.999)).toBe('warn');
    expect(bandOf(60)).toBe('warn');
    expect(bandOf(59.999)).toBe('crit');
    expect(bandOf(0)).toBe('crit');
  });

  it('treats nothing-applicable as N/A rather than as a zero score', () => {
    expect(bandOf(null)).toBe('none');
    expect(bandLabel(null)).toBe('N/A');
    expect(score1(null)).toBe('N/A');
    expect(score2(null)).toBe('N/A');
    expect(score3(null)).toBe('N/A');
  });
});

describe('figures', () => {
  it('shows one decimal in tiles, two in audit tables and three in records', () => {
    expect(score1(76.94)).toBe('76.9');
    expect(score2(76.94)).toBe('76.94');
    expect(score3(76.94)).toBe('76.940');
  });

  it('pads an audit score to two decimals so a column of them stays aligned', () => {
    expect(score2(80)).toBe('80.00');
    expect(score2(76.9)).toBe('76.90');
  });

  it('never lets the displayed rounding decide a band', () => {
    // 74.999 is Improving; rounding it for display reads as 75.00, which is On Track. The
    // band must come from the raw value, never be re-derived from this string. R-6b puts
    // the four boundaries at 90 / 75 / 60.
    expect(score2(74.999)).toBe('75.00');
    expect(bandOf(74.999)).toBe('warn');
    expect(bandOf(75)).toBe('ok');
  });

  it('always signs a delta, with a real minus sign', () => {
    expect(delta1(0)).toBe('+0.0');
    expect(delta1(2.44)).toBe('+2.4');
    expect(delta1(-2.9)).toBe('−2.9');
    expect(delta1(null)).toBe('—');
  });
});

describe('mergeBoard', () => {
  const sections: LatestZoneAudit = {
    sections: [],
    auditorName: 'R. Deshmukh',
    completedAt: '2026-09-09T18:02:00.000Z',
  };

  it('keeps a zone the rollup has not reached as pending but not as unaudited', () => {
    const board = mergeBoard(
      [zone('z1', 'PRESS_SHOP')],
      [],
      new Map([['PRESS_SHOP', sections]]),
    );
    expect(board[0]!.ranked).toBe(false);
    expect(board[0]!.score).toBeNull();
    // The audit's own breakdown still shows, and the tile must not read "not started".
    expect(board[0]!.sections).toEqual([]);
    expect(board[0]!.auditorName).toBe('R. Deshmukh');
    expect(awaitingRollup(board[0]!)).toBe(true);
  });

  it('keeps unaudited zones on the board as pending, not as zeros', () => {
    const board = mergeBoard(
      [zone('z1', 'BOILER'), zone('z2', 'OFFICE')],
      [ranked('z1', 'BOILER', 48.6)],
      new Map([['BOILER', sections]]),
    );
    expect(board.map((row) => row.code)).toEqual(['BOILER', 'OFFICE']);
    expect(board[0]!.score).toBe(48.6);
    expect(board[0]!.band).toBe('crit');
    expect(board[0]!.auditorName).toBe('R. Deshmukh');
    expect(board[1]!.score).toBeNull();
    expect(board[1]!.band).toBe('none');
    expect(board[1]!.sections).toBeNull();
    expect(board[0]!.ranked).toBe(true);
    expect(awaitingRollup(board[1]!)).toBe(false);
  });

  it('leaves archived zones off the board', () => {
    const board = mergeBoard(
      [zone('z1', 'OLD', { archivedAt: '2026-01-01T00:00:00.000Z' })],
      [],
      new Map(),
    );
    expect(board).toHaveLength(0);
  });
});

describe('trendGeometry', () => {
  it('has nothing to draw when no period carries a score', () => {
    expect(trendGeometry([{ period: '2026-09', scorePercentage: null }])).toBeNull();
  });

  it('scales to the values the chart actually reaches, target rule included', () => {
    const geometry = trendGeometry([
      { period: '2026-07', scorePercentage: 62.1 },
      { period: '2026-08', scorePercentage: null },
      { period: '2026-09', scorePercentage: 76.9 },
    ])!;
    expect(geometry.yTicks.map((tick) => tick.label)).toEqual(['100', '80', '60', '40']);
    // A higher score sits higher on the page, and the endpoint is the last scored period.
    expect(geometry.end.value).toBe(76.9);
    expect(geometry.end.y).toBeLessThan(geometry.yTicks.at(-1)!.y);
    expect(geometry.xTicks.map((tick) => tick.label)).toEqual(['2026-07', '2026-09']);
    // The Outstanding rule is inside the plot, above the current value.
    expect(geometry.targetY).toBeGreaterThan(16);
    expect(geometry.targetY).toBeLessThan(geometry.end.y);
    expect(TARGET).toBe(90);
  });
});

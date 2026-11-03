import { describe, expect, it } from 'vitest';
import type { AuditScoreSummary } from '@audit5s/contracts';
import { renderScorecardHtml, scorecardFileName, type ScorecardAudit } from './scorecard-html';

const sections = (['SEIRI', 'SEITON', 'SEISO', 'SEIKETSU', 'SHITSUKE'] as const).map((section, index) => ({
  section,
  applicable: 10,
  na: index === 4 ? 10 : 0,
  raw: index === 4 ? 0 : 15,
  max: index === 4 ? 0 : 20,
  pct: index === 4 ? null : 75,
}));
const totals = { rawScore: 60, maxScore: 80, scorePercentage: 75, applicableQuestions: 40, naQuestions: 10 };
const summary = {
  scored: true,
  audit: { auditId: 'a', auditZoneId: null, totals, sections },
  zones: [
    {
      auditId: 'a',
      auditZoneId: 'z',
      totals,
      sections,
      zoneCode: 'Z-07',
      zoneName: 'Press shop',
      auditeeName: 'S. Patil',
      checklistTemplateName: 'Engineering',
      status: 'COMPLETED',
    },
  ],
} as unknown as AuditScoreSummary;
const audit: ScorecardAudit = {
  unitName: 'Insumat Division',
  auditorName: 'Cara Consult',
  auditType: 'CROSS_5S',
  completedAt: '2026-11-02T06:30:00.000Z',
  startedAt: '2026-11-02T05:00:00.000Z',
};

describe('the score card (R-80)', () => {
  it('names the Unit and the Zone in its file name', () => {
    expect(scorecardFileName(audit, summary)).toBe('Score card - Insumat Division - Zone 7 Press shop - 02 Nov 2026.pdf');
  });

  it('prints the Unit, the Zone, the auditee, and N/A — never 0 — for an all-NA S', () => {
    const html = renderScorecardHtml(audit, summary);
    expect(html).toContain('Insumat Division');
    expect(html).toContain('Zone 7 — Press shop');
    expect(html).toContain('S. Patil');
    expect(html).toContain('Cross audit');
    expect(html).toContain('N/A');
  });
});

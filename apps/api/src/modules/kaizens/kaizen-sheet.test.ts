import { writeFileSync } from 'node:fs';
import type { KaizenDetail } from '@audit5s/contracts';
import { describe, expect, it } from 'vitest';
import { compactRupees, costNote, numberedLines, renderKaizenSheetHtml } from './kaizen-sheet';

const id = '00000000-0000-4000-8000-000000000001';
const kaizen: KaizenDetail = {
  id, kaizenNo: 'KZ-Z07-001', unitId: id, unitName: 'Pune Plant', zoneId: id, zoneCode: 'Z07',
  zoneName: 'Press Shop', department: null, authorUserId: id, authorName: 'Ravi Patil',
  machine: 'Press P-12', lineArea: 'Line 3', implementedOn: '2026-10-05',
  teamMembers: 'Ravi Patil (lead) · Asha K · Imran S', theme: 'Cut die changeover time on press P-12',
  target: '≤ 20 min by 30-11-2026', problem5w1h: 'What: changeover takes 48 min\nWhere: press P-12',
  rootCause4m: 'Method: no standard sequence\nMaterial: dies stored far away', analysis7qc: 'Pareto: tool search 40%',
  countermeasure: '1. Shadow board at the press\n2. Quick-release clamps\n- SOP card', wastes: ['WAITING_TIME', 'MOTION'],
  parameters: ['PRODUCTIVITY', 'COST'], horizontalDeployment: true, benefits: 'Changeover 48 → 18 min.',
  annualSaving: 420000, implementationCost: 35000, ideaBy: 'Asha K', implementedBy: null, status: 'APPROVED', submittedAt: null,
  latestReview: null, beforePhoto: null, afterPhoto: null,
  createdAt: '2026-10-01T05:00:00.000Z', updatedAt: '2026-10-06T05:00:00.000Z',
  reviews: [{
    id, kaizenId: id, reviewerUserId: id, reviewerName: 'Meera Joshi', reviewerRole: 'COORDINATOR',
    decision: 'APPROVED', comment: null, createdAt: '2026-10-06T05:00:00.000Z',
  }],
} as KaizenDetail;

describe('Kaizen sheet', () => {
  it('numbers countermeasures, dropping typed numbering', () => {
    expect(numberedLines('1. a\n\n2) b\n- c')).toEqual(['a', 'b', 'c']);
    expect(numberedLines(null)).toEqual([]);
  });

  it('shortens rupees to fit a metric card', () => {
    expect(compactRupees(420000)).toBe('₹4.2L');
    expect(compactRupees(25000000)).toBe('₹2.5Cr');
    expect(compactRupees(950)).toBe('₹950');
    expect(compactRupees(null)).toBe('—');
    expect(compactRupees(0)).toBe('₹0');
  });

  it('prints a zero cost as an answer, apart from a cost not stated', () => {
    expect(costNote(0)).toBe('no cost');
    expect(costNote(null)).toBe('not stated');
    expect(costNote(35000)).toBe('₹35,000');
  });

  it('renders the template with the record and escapes what the writer typed', () => {
    const html = renderKaizenSheetHtml({ ...kaizen, theme: '<b>x</b>' }, { before: null, after: null });
    expect(html).toContain('KZ-Z07-001');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('[photo / sketch]');
    expect(html).toContain('<b>▼</b>');
    expect(html).toContain('Cost to implement');
    if (process.env.KAIZEN_SHEET_OUT) {
      writeFileSync(process.env.KAIZEN_SHEET_OUT, renderKaizenSheetHtml(kaizen, { before: null, after: null }));
    }
  });
});

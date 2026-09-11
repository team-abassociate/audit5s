import ExcelJS from 'exceljs';

/**
 * Synthetic department workbooks, built in the shape of the real file (HANDOFF.md §3.4).
 *
 * Built rather than committed as binaries: a broken fixture in git is a file nobody can
 * read the diff of, and "9 questions in a section" is far clearer as one option here than
 * as a second `.xlsx` whose difference from the first is invisible in review.
 *
 * The real workbook is exercised too — `checklist-import.e2e.test.ts` imports
 * `docs/requirements/5S_lean_audit_data_1.xlsx` itself, and the seed does the same.
 */

const SECTION_HEADERS = [
  '1S – SEIRI (SORT)',
  '2S – SEITON (SET IN ORDER)',
  '3S – SEISO (SHINE)',
  '4S – SEIKETSU (STANDARDIZE)',
  '5S – SHITSUKE (SUSTAIN)',
];

export interface SheetSpec {
  name: string;
  /** Per-section question counts. Anything but ten is a CQ-1 error. */
  counts?: number[];
  /** Omit a section header entirely. */
  dropSection?: number;
  /** Question text; defaults to something unique per position. */
  text?: (section: number, position: number) => string;
  /** Rewrites the `Sr.` value, for testing the contiguity rule. */
  sr?: (sr: number) => number;
  /** Written into A1 instead of the checklist title, so the sheet is skipped. */
  title?: string;
}

export function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const spec of sheets) {
    const worksheet = workbook.addWorksheet(spec.name);
    worksheet.addRow([spec.title ?? `5S AUDIT CHECK SHEET – ${spec.name.toUpperCase()}`]);
    worksheet.addRow(['Company:', null, 'Audit Date:', null, 'Scoring: Yes = 2 marks, No = 0 marks.']);
    worksheet.addRow(['Area / Dept.:', spec.name, 'Auditor Name:']);
    worksheet.addRow(['Shift:', null, 'Auditee / Area Owner:']);
    worksheet.addRow([]);
    worksheet.addRow(['Sr.', 'Check Point', 'Yes / No', 'Marks', 'Remarks / Observations']);

    const counts = spec.counts ?? [10, 10, 10, 10, 10];
    const text = spec.text ?? ((section, position) => `${spec.name} S${section} Q${position}`);

    let sr = 0;
    for (let section = 1; section <= 5; section += 1) {
      if (spec.dropSection === section) continue;
      worksheet.addRow([SECTION_HEADERS[section - 1]]);
      for (let position = 1; position <= (counts[section - 1] ?? 10); position += 1) {
        sr += 1;
        worksheet.addRow([spec.sr ? spec.sr(sr) : sr, text(section, position), null, 0, null]);
      }
      worksheet.addRow([`Sub-total ${section}S (out of 20)`, null, null, 0, null]);
    }

    worksheet.addRow(['TOTAL SCORE (out of 100)', null, null, 0]);
    worksheet.addRow(['PERCENTAGE', null, null, 0]);
    worksheet.addRow(['RATING', null, null, 'Needs Support']);
    worksheet.addRow([]);
    worksheet.addRow([null, 'Auditor Signature: ______________________']);
    worksheet.addRow(['Prepared by AB Associates, Nashik.']);
  }

  return workbook.xlsx.writeBuffer().then((buffer) => Buffer.from(buffer));
}

/** One well-formed department sheet. */
export function validWorkbook(name = 'Premises'): Promise<Buffer> {
  return buildWorkbook([{ name }]);
}

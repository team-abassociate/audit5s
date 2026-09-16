import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BRAND_TOKENS } from '@audit5s/domain';
import type { SheetToPersist } from './checklist-import.repository';

/**
 * The annotated error workbook of §8.5.
 *
 * A validation report on screen tells a Super Admin *that* the file is wrong. This tells
 * them *where*: one row per finding, with the sheet, the row number, what was read and
 * what is wrong with it, in the same format they will open to fix it.
 *
 * Rows the parser was happy with are not listed. A report that repeats fifty accepted
 * questions buries the three that failed.
 */
@Injectable()
export class ChecklistErrorReportWriter {
  async build(sheets: SheetToPersist[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'audit5s';
    workbook.created = new Date();

    this.writeSummary(workbook, sheets);
    this.writeFindings(workbook, sheets);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private writeSummary(workbook: ExcelJS.Workbook, sheets: SheetToPersist[]): void {
    const summary = workbook.addWorksheet('Summary');
    summary.columns = [
      { header: 'Sheet', key: 'sheet', width: 24 },
      { header: 'Department code', key: 'code', width: 20 },
      { header: 'Questions read', key: 'questions', width: 16 },
      { header: 'Verdict', key: 'severity', width: 12 },
      { header: 'Notes', key: 'messages', width: 90 },
    ];
    header(summary.getRow(1));

    for (const sheet of sheets) {
      const row = summary.addRow({
        sheet: sheet.sheetName,
        code: sheet.templateCode,
        questions: sheet.questionCount,
        severity: sheet.severity,
        messages: sheet.messages.join(' · '),
      });
      tint(row.getCell('severity'), sheet.severity);
    }
  }

  private writeFindings(workbook: ExcelJS.Workbook, sheets: SheetToPersist[]): void {
    const findings = workbook.addWorksheet('Findings');
    findings.columns = [
      { header: 'Sheet', key: 'sheet', width: 24 },
      { header: 'Row', key: 'row', width: 8 },
      { header: 'Sr.', key: 'sr', width: 8 },
      { header: 'Section', key: 'section', width: 20 },
      { header: 'Check Point as read', key: 'text', width: 70 },
      { header: 'Verdict', key: 'severity', width: 12 },
      { header: 'What is wrong', key: 'messages', width: 90 },
    ];
    header(findings.getRow(1));

    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        if (row.severity === 'OK') continue;
        const added = findings.addRow({
          sheet: sheet.sheetName,
          row: row.sourceRowNumber,
          sr: row.parsedGlobalOrder,
          section: row.parsedSection,
          text: row.parsedText,
          severity: row.severity,
          messages: row.messages.join(' · '),
        });
        tint(added.getCell('severity'), row.severity);
      }
    }

    if (findings.rowCount === 1) {
      findings.addRow({ sheet: '', messages: 'No row-level findings.' });
    }
  }
}

/** The ink header band the reports use, so the artefact looks like the product. */
function header(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${BRAND_TOKENS.ink.slice(1).toUpperCase()}` },
  };
}

function tint(cell: ExcelJS.Cell, severity: 'OK' | 'WARNING' | 'ERROR'): void {
  const argb =
    severity === 'ERROR' ? 'FFFCE7E5' : severity === 'WARNING' ? 'FFFDF3DB' : 'FFE2F4E9';
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

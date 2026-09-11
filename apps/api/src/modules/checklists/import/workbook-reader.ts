import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { CellValue, SheetGrid } from '@audit5s/domain';

/**
 * Turns an uploaded `.xlsx` into the plain cell grids `packages/domain` parses.
 *
 * This is the only place in the import that touches a file format. Everything downstream
 * — the sheet-recognition rule, the section regex, the question-row rule, the 5×10 check
 * — works on `CellValue[][]` and is therefore testable without a spreadsheet.
 *
 * §12.8's controls for a malicious workbook live here:
 *
 *   * the magic bytes are checked, not the extension or the declared content type;
 *   * a hard byte cap is applied before the parser is handed anything;
 *   * row and column limits bound the work a crafted file can ask for;
 *   * **formulas are never evaluated.** ExcelJS does not evaluate them either way; what
 *     this reader does is refuse to treat a formula as anything but the literal value the
 *     file already contains, so a `=WEBSERVICE(...)` cell reads as empty rather than as
 *     an instruction;
 *   * external references are not followed — nothing here resolves a link.
 */

/** `PK\x03\x04` — every `.xlsx` is a zip container. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Well past the 74 rows the real workbook uses, and far short of a decompression bomb. */
export const MAX_SHEET_ROWS = 5_000;
/** The profile reads columns A and B; the rest is bounded so `raw` cannot grow unbounded. */
export const MAX_SHEET_COLUMNS = 32;

export class WorkbookRejected extends Error {}

export interface ReadWorkbookOptions {
  maxBytes: number;
}

@Injectable()
export class WorkbookReader {
  /** Throws `WorkbookRejected` for anything that is not a plausible `.xlsx`. */
  assertAcceptable(body: Buffer, options: ReadWorkbookOptions): void {
    if (body.byteLength === 0) {
      throw new WorkbookRejected('The uploaded file is empty');
    }
    if (body.byteLength > options.maxBytes) {
      throw new WorkbookRejected(
        `The file is ${body.byteLength} bytes; the limit is ${options.maxBytes}`,
      );
    }
    if (!body.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
      // Checked by content, not by name: §12.8 does not trust a declared type.
      throw new WorkbookRejected('The file is not an .xlsx workbook');
    }
  }

  async read(body: Buffer, options: ReadWorkbookOptions): Promise<SheetGrid[]> {
    this.assertAcceptable(body, options);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(body as unknown as ArrayBuffer);
    } catch (error) {
      throw new WorkbookRejected(
        `The workbook could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return workbook.worksheets.map((worksheet, index) => this.toGrid(worksheet, index));
  }

  private toGrid(worksheet: ExcelJS.Worksheet, index: number): SheetGrid {
    const rowCount = Math.min(worksheet.rowCount, MAX_SHEET_ROWS);
    const columnCount = Math.min(Math.max(worksheet.columnCount, 2), MAX_SHEET_COLUMNS);
    const rows: CellValue[][] = [];

    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const cells: CellValue[] = [];
      for (let column = 1; column <= columnCount; column += 1) {
        cells.push(toCellValue(row.getCell(column).value));
      }
      rows.push(cells);
    }

    // `index` is the position in the workbook, which is what fixes template order (R-6a).
    return { name: worksheet.name, index, rows };
  }
}

/**
 * Reduces an ExcelJS cell to a primitive.
 *
 * A formula cell yields the result the file already stores, and only when that result is
 * itself a primitive — never the formula text, and never a computation performed here.
 */
function toCellValue(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text).join('');
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('result' in value) {
      const result = (value as { result?: unknown }).result;
      if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
        return result;
      }
      return null;
    }
    if ('error' in value) return null;
  }

  return null;
}

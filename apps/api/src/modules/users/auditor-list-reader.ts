import type { CellValue } from '@audit5s/domain';
import { ZONE_LIST_IMPORT_MAX_BYTES } from '@audit5s/contracts';
import { WorkbookReader, WorkbookRejected } from '../checklists/import/workbook-reader';

/**
 * Reads a Unit's Auditor list from an Excel workbook (R-64): the people a Coordinator gives
 * an account — each Zone's leaders, ZL1 to ZL3, and anyone auditing with no Zone at all.
 *
 * Name and Mobile No. are read, found by their headings. Zone No. and ZL, when there, only
 * name the row in a note: an account is not tied to a Zone, whose leaders are the names the
 * Zone list gives it. A name with no usable number is still read (R-65): its account waits
 * for the number, which the Coordinator adds in People.
 */

export interface ImportedAuditor {
  name: string;
  /** Ten digits; null when the row has none, or none that is a mobile number (R-65). */
  phone: string | null;
}

export interface AuditorList {
  auditors: ImportedAuditor[];
  /** Rows that make no account, or one without its number, and why — shown to whoever imported. */
  notes: string[];
}

export class AuditorListRejected extends Error {}

const MAX_NAME = 200;
const MAX_PEOPLE = 500;

const HEADINGS = {
  zoneNo: /^zone\s*(no\.?|number|#|code)?$/i,
  slot: /^zl\s*(no\.?|#)?$/i,
  name: /^(((zone\s*)?leaders?|auditors?)(\s*name)?|name)$/i,
  phone: /^(mobile|phone|contact|cell)(\s*(no\.?|number|#))?$/i,
} as const;
type Column = keyof typeof HEADINGS;
const COLUMNS = Object.keys(HEADINGS) as Column[];

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `+91 98765-43210` → `9876543210`; `null` unless it is a ten-digit mobile number. */
export function mobileNumber(text: string): string | null {
  const digits = text.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

export async function readAuditorList(body: Buffer): Promise<AuditorList> {
  if (body.byteLength === 0) throw new AuditorListRejected('The file is empty');
  if (body.byteLength > ZONE_LIST_IMPORT_MAX_BYTES) {
    throw new AuditorListRejected('The file is larger than 5 MB');
  }
  let sheets;
  try {
    sheets = await new WorkbookReader().read(body, { maxBytes: ZONE_LIST_IMPORT_MAX_BYTES });
  } catch (error) {
    if (error instanceof WorkbookRejected) {
      throw new AuditorListRejected('Upload the Auditor list as an Excel workbook (.xlsx)');
    }
    throw error;
  }

  const text = (cell: CellValue | undefined) => (cell === null || cell === undefined ? '' : clean(String(cell)));
  for (const sheet of sheets) {
    const headerIndex = sheet.rows.findIndex((row) => headerColumns(row.map(text)) !== null);
    if (headerIndex === -1) continue;
    const columns = headerColumns(sheet.rows[headerIndex]!.map(text))!;
    const auditors: ImportedAuditor[] = [];
    const notes: string[] = [];
    sheet.rows.slice(headerIndex + 1).forEach((row, offset) => {
      const name = text(row[columns.name]);
      const phoneText = text(row[columns.phone]);
      // A Zone and a ZL alone are a template row nobody filled in.
      if (!name && !phoneText) return;
      // "Zone 01", as the template writes it, is named "Zone 1".
      const zone = (columns.zoneNo === undefined ? '' : text(row[columns.zoneNo]))
        .replace(/^zone\s*(no\.?)?\s*[-:#.]?\s*/i, '')
        .replace(/^0+(?=.)/, '');
      const slot = columns.slot === undefined ? '' : text(row[columns.slot]);
      const where = zone ? `Zone ${zone}${slot ? ` ${slot}` : ''}` : `row ${headerIndex + offset + 2}`;
      const phone = mobileNumber(phoneText);
      if (!name) notes.push(`${where}: a mobile number with no name, so no account was made`);
      else if (name.length > MAX_NAME) notes.push(`${where}: the name is longer than ${MAX_NAME} characters`);
      else {
        // R-65: a number that is not one is dropped, and said so; the account waits for it.
        if (phoneText && !phone) {
          notes.push(`${where}: "${phoneText}" is not a 10-digit mobile number. Add ${name}'s number in People.`);
        }
        auditors.push({ name, phone });
      }
    });
    if (auditors.length === 0 && notes.length === 0) throw new AuditorListRejected('The file lists nobody');
    if (auditors.length > MAX_PEOPLE) throw new AuditorListRejected(`The file lists more than ${MAX_PEOPLE} people`);
    return { auditors, notes };
  }
  throw new AuditorListRejected(
    'No heading row with Name and Mobile No. was found. Use the Auditor list template.',
  );
}

/** Each column's index in a header row, or `null` unless Name and Mobile No. are there. */
function headerColumns(cells: string[]): (Record<'name' | 'phone', number> & Partial<Record<Column, number>>) | null {
  const found: Partial<Record<Column, number>> = {};
  cells.forEach((cell, index) => {
    const value = cell.replace(/[:*]$/, '');
    const column = value ? COLUMNS.find((key) => HEADINGS[key].test(value)) : undefined;
    if (column && found[column] === undefined) found[column] = index;
  });
  return found.name !== undefined && found.phone !== undefined
    ? (found as Record<'name' | 'phone', number> & Partial<Record<Column, number>>)
    : null;
}

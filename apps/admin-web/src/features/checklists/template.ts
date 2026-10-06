import {
  QUESTIONS_PER_SECTION,
  S_SECTION_LABELS,
  S_SECTION_ORDER,
  normalizeQuestionText,
  parseChecklistSheet,
  templateCodeForSheet,
  validateChecklistSheet,
  type CellValue,
} from '@audit5s/domain';

/**
 * The blank import workbook (CL1), built from the import profile itself (R-6d,
 * `packages/domain` checklist-import): the `A1` title the importer looks for, the `Sr.` header
 * row with the optional translation columns, the five section headers exactly as the
 * importer matches them, and `Sr.` 1–50 with the Check Points left blank to fill in.
 * Change the profile and the template follows; `template.test.ts` holds the two together.
 */
export const TEMPLATE_SHEET_NAME = 'Department';

/**
 * A checklist written in the in-app editor (D13): the department (the sheet name) and the
 * 50 Check Points in `Sr.` order, each with optional Hindi and Marathi. It travels as the
 * very workbook a person could have uploaded, so the import validates, diffs, commits and
 * audit-logs it under the same rules — there is no second way to make a checklist.
 */
export interface ChecklistDraft {
  name: string;
  questions: Array<{ text: string; hi: string; mr: string }>;
}

export function templateRows(draft?: ChecklistDraft): CellValue[][] {
  const rows: CellValue[][] = [
    [`5S AUDIT CHECK SHEET – ${(draft?.name ?? TEMPLATE_SHEET_NAME).toUpperCase()}`],
    draft
      ? []
      : [
          'One sheet per department: name the sheet after the department and copy it for each ' +
            'one. Fill in all 50 Check Points. The Hindi and Marathi columns are optional.',
        ],
    [],
    ['Sr.', 'Check Point', 'Check Point (Hindi)', 'Check Point (Marathi)'],
  ];
  // The importer's own normalisation, so a stray space or a line break typed into the
  // editor is not reported back as a workbook warning.
  const clean = (text: string) => normalizeQuestionText(text).text;
  let sr = 0;
  for (const section of S_SECTION_ORDER) {
    rows.push([S_SECTION_LABELS[section]]);
    for (let n = 0; n < QUESTIONS_PER_SECTION; n += 1) {
      const question = draft?.questions[sr];
      sr += 1;
      rows.push(
        question ? [sr, clean(question.text), clean(question.hi), clean(question.mr)] : [sr],
      );
    }
  }
  return rows;
}

/** The editor's checklist as the workbook the import reads. */
export function draftWorkbook(draft: ChecklistDraft): File {
  return new File([xlsx(draft.name, templateRows(draft))], `${draft.name}.xlsx`, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** What the editor shows under its fields. Empty everywhere means the draft will import. */
export interface DraftCheck {
  name: string | null;
  /** Indexed like `draft.questions`: the first message per question. */
  errors: Array<string | null>;
  warnings: Array<string | null>;
}

/**
 * The editor's live check: the import's own `parseChecklistSheet` and
 * `validateChecklistSheet` run on the workbook the draft becomes, so the editor can never
 * pass something the import refuses. The server runs them again; this is only earlier.
 *
 * The name rules are a workbook's: it is the sheet name, so Excel's 31 characters and
 * forbidden characters apply, and it must leave a template code.
 */
export function checkDraft(draft: ChecklistDraft): DraftCheck {
  const name = draft.name.trim();
  const nameError =
    name === ''
      ? 'Name the department this checklist is for'
      : name.length > 31
        ? 'Keep it to 31 characters, the limit for a sheet name'
        : /[[\]:*?/\\]/.test(name)
          ? 'Leave out [ ] : * ? / and \\'
          : templateCodeForSheet(name) === ''
            ? 'Use at least one letter or number'
            : null;

  // A blank question is not a row to the parser, which would then misnumber every question
  // after it; a unique stand-in keeps the rest of the check about the rest of the sheet.
  const filled = {
    name: draft.name,
    questions: draft.questions.map((question, index) =>
      question.text.trim() === '' ? { ...question, text: `blank ${index + 1}` } : question,
    ),
  };
  const rows = validateChecklistSheet(
    parseChecklistSheet({ name: name || TEMPLATE_SHEET_NAME, index: 0, rows: templateRows(filled) }),
  ).rows;
  const byOrder = new Map(rows.map((row) => [row.globalOrder, row]));
  const errors: Array<string | null> = [];
  const warnings: Array<string | null> = [];
  draft.questions.forEach((question, index) => {
    const row = byOrder.get(index + 1);
    // A blank Check Point is not a question row to the parser, so it is named here.
    errors.push(
      question.text.trim() === ''
        ? 'Write the question in English'
        : row?.severity === 'ERROR'
          ? (row.messages[0] ?? null)
          : null,
    );
    warnings.push(row?.severity === 'WARNING' ? row.messages.join(' · ') : null);
  });
  return { name: nameError, errors, warnings };
}

export function downloadTemplate(): void {
  const url = URL.createObjectURL(
    new Blob([xlsx(TEMPLATE_SHEET_NAME, templateRows())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '5s-checklist-template.xlsx';
  anchor.click();
  URL.revokeObjectURL(url);
}

// ponytail: the smallest valid .xlsx (inline strings, no styles) in a stored zip, rather
// than a spreadsheet library in the bundle for one blank sheet. Columns A–D only.
const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function xlsx(sheetName: string, rows: CellValue[][]): Uint8Array<ArrayBuffer> {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          if (value === null || value === '') return '';
          return typeof value === 'number'
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${escape(String(value))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org';
  const rel = `${ns}/officeDocument/2006/relationships`;
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    [
      '[Content_Types].xml',
      `${head}<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `${head}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `${head}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${head}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `${head}<worksheet xmlns="${ns}/spreadsheetml/2006/main"><cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="4" width="60" customWidth="1"/></cols><sheetData>${body}</sheetData></worksheet>`,
    ],
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every entry stored (method 0): valid, and all an .xlsx reader needs. */
function zip(files: Array<[string, string]>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    // Version 2.0, UTF-8 names, stored, 1980-01-01 00:00, crc, sizes, name length.
    const fields = (view: DataView, at: number) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, 0x0800, true);
      view.setUint16(at + 4, 0, true);
      view.setUint16(at + 6, 0, true);
      view.setUint16(at + 8, 0x21, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, data.length, true);
      view.setUint32(at + 18, data.length, true);
      view.setUint16(at + 22, nameBytes.length, true);
    };

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    fields(lv, 4);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    fields(cv, 6);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

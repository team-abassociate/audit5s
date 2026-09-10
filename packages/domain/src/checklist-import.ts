import type { ChecklistDiffEntry, ImportSeverity, SSection } from '@audit5s/contracts';
import { QUESTIONS_PER_SECTION, S_SECTION_ORDER, TOTAL_QUESTIONS } from './sections';

/**
 * The `ChecklistImportProfile` of ARCHITECTURE.md §8.5, as pure functions.
 *
 * The real department workbook is **not** a flat one-row-per-question table: it is one
 * sheet per department, with section-header rows between blocks of ten questions
 * (HANDOFF.md §3.4, DECISIONS.md R-6d). Everything here works on a plain grid of cell
 * values, so the rules are testable without a spreadsheet and the reader that produces the
 * grid is the only part that touches a file.
 *
 * Row numbers are never load-bearing. Sections are found by regex on column A precisely
 * because a maintainer inserting a row must not silently shift a checklist.
 */

/** A cell as the reader hands it over: primitives only, never a formula or a rich-text run. */
export type CellValue = string | number | boolean | null;

export interface SheetGrid {
  name: string;
  /** Position in the workbook, 0-based. Fixes the template order (R-6a). */
  index: number;
  /** 1-based row N of the sheet is `rows[N - 1]`; short rows are padded by the reader. */
  rows: CellValue[][];
}

/**
 * A sheet is a checklist only if `A1` says so. Every other sheet is skipped, which is how
 * the workbook's three legacy planning tabs are excluded without naming them (Q7).
 */
export const CHECKLIST_SHEET_TITLE_PATTERN = /^5S\s+AUDIT\s+CHECK\s+SHEET\s*[–—-]\s*(.+)$/i;

/** En dash, em dash and hyphen all appear in the wild; all three are accepted. */
export const SECTION_HEADER_PATTERN =
  /^([1-5])S\s*[–—-]\s*(SEIRI|SEITON|SEISO|SEIKETSU|SHITSUKE)\b/i;

export const MAX_QUESTION_TEXT_LENGTH = 500;

const SECTION_BY_NUMBER: Readonly<Record<string, SSection>> = {
  '1': 'S1_SORT',
  '2': 'S2_SET_IN_ORDER',
  '3': 'S3_SHINE',
  '4': 'S4_STANDARDIZE',
  '5': 'S5_SUSTAIN',
};

function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** The `Sr.` column, when the cell holds a whole number and nothing else. */
function cellInteger(value: CellValue | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  const text = cellText(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** `Stores (RM)` → `STORES_RM`. The sheet name is authoritative for both code and name. */
export function templateCodeForSheet(sheetName: string): string {
  return sheetName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function sheetChecklistTitle(a1: CellValue | undefined): string | null {
  const match = CHECKLIST_SHEET_TITLE_PATTERN.exec(cellText(a1).trim());
  return match ? (match[1] ?? '').trim() : null;
}

export function isChecklistSheet(grid: SheetGrid): boolean {
  return sheetChecklistTitle(grid.rows[0]?.[0]) !== null;
}

export function sectionForHeaderRow(value: CellValue | undefined): SSection | null {
  const match = SECTION_HEADER_PATTERN.exec(cellText(value).trim());
  if (!match) return null;
  return SECTION_BY_NUMBER[match[1] ?? ''] ?? null;
}

export interface TextNormalization {
  text: string;
  /** WARNING-level notes; §8.5 stage 3 auto-normalizes rather than rejecting. */
  notes: string[];
}

const SMART_QUOTES: Array<[RegExp, string, string]> = [
  [/[‘’‛]/g, "'", 'curly apostrophes replaced with a straight quote'],
  [/[“”‟]/g, '"', 'curly quotes replaced with straight quotes'],
  [/[–—]/g, '-', 'en/em dashes replaced with a hyphen'],
  [/…/g, '...', 'ellipsis character expanded'],
];

/**
 * Normalizes a question as stage 3 requires: the stored text is the normalized form and
 * the change is reported as a warning, so a re-import of the same file is byte-identical
 * rather than a perpetual near-duplicate.
 */
export function normalizeQuestionText(raw: string): TextNormalization {
  const notes: string[] = [];
  let text = raw;

  if (/^\s|\s$/.test(text)) {
    notes.push('leading or trailing whitespace removed');
  }
  text = text.trim();

  if (/[\s\u00a0]{2,}|[\n\r\t]/.test(text)) {
    notes.push('internal whitespace collapsed to single spaces');
  }
  text = text.replace(/[\s\u00a0]+/g, ' ');

  for (const [pattern, replacement, note] of SMART_QUOTES) {
    if (pattern.test(text)) {
      notes.push(note);
      text = text.replace(pattern, replacement);
    }
  }

  return { text, notes };
}

// ------------------------------------------------------------------ stage 2: PARSE

export interface ParsedQuestionRow {
  /** 1-based sheet row, so an error report can point a person at the cell. */
  sourceRowNumber: number;
  /** Null when the row appears before any section header — an ERROR at stage 3. */
  section: SSection | null;
  /** Position within the current section, 1…10. Null when there is no section yet. */
  orderInSection: number | null;
  /** The `Sr.` value, i.e. the global order the sheet claims. */
  globalOrder: number;
  text: string;
  /** The original cells, kept verbatim for `checklist_import_row.raw`. */
  raw: { sr: CellValue; checkPoint: CellValue };
  notes: string[];
}

export interface ParsedSheet {
  name: string;
  index: number;
  /** The department as `A1` spells it, upper-cased in the file. Display uses the name. */
  title: string;
  templateCode: string;
  questions: ParsedQuestionRow[];
  sectionsSeen: Array<{ section: SSection; sourceRowNumber: number }>;
  /** Sub-totals, the trailing totals block, notes and signatures. Counted, not stored. */
  skippedRowCount: number;
}

/**
 * Reads one sheet into question rows.
 *
 * A question row is one whose column A is an integer and whose column B is non-empty.
 * That single rule excludes every sub-total (`Sub-total 1S (out of 20)`), the trailing
 * `TOTAL SCORE` / `PERCENTAGE` / `RATING` block, the rating-scale note and the signature
 * line, without a list of strings to keep in step with the workbook.
 *
 * The `Yes / No` and `Marks` columns are legacy and are not read at all: the application
 * scale is `2 / 1 / 0 / NA` (D3).
 */
export function parseChecklistSheet(grid: SheetGrid): ParsedSheet {
  const title = sheetChecklistTitle(grid.rows[0]?.[0]) ?? grid.name;
  const questions: ParsedQuestionRow[] = [];
  const sectionsSeen: Array<{ section: SSection; sourceRowNumber: number }> = [];
  let skippedRowCount = 0;

  let currentSection: SSection | null = null;
  let orderInSection = 0;

  for (let index = 0; index < grid.rows.length; index += 1) {
    const sourceRowNumber = index + 1;
    const row = grid.rows[index] ?? [];
    const columnA = row[0] ?? null;
    const columnB = row[1] ?? null;

    const headerSection = sectionForHeaderRow(columnA);
    if (headerSection) {
      currentSection = headerSection;
      orderInSection = 0;
      sectionsSeen.push({ section: headerSection, sourceRowNumber });
      continue;
    }

    const sr = cellInteger(columnA);
    const checkPoint = cellText(columnB).trim();
    if (sr === null || checkPoint === '') {
      if (cellText(columnA).trim() !== '' || checkPoint !== '') {
        skippedRowCount += 1;
      }
      continue;
    }

    const normalized = normalizeQuestionText(cellText(columnB));
    orderInSection += 1;
    questions.push({
      sourceRowNumber,
      section: currentSection,
      orderInSection: currentSection ? orderInSection : null,
      globalOrder: sr,
      text: normalized.text,
      raw: { sr: columnA, checkPoint: columnB },
      notes: normalized.notes,
    });
  }

  return {
    name: grid.name,
    index: grid.index,
    title,
    templateCode: templateCodeForSheet(grid.name),
    questions,
    sectionsSeen,
    skippedRowCount,
  };
}

// --------------------------------------------------------------- stage 3: VALIDATE

export interface ValidatedRow {
  sourceRowNumber: number;
  section: SSection | null;
  orderInSection: number | null;
  globalOrder: number | null;
  text: string | null;
  raw: unknown;
  severity: ImportSeverity;
  messages: string[];
}

/** A question as it would be committed, once the sheet validates. */
export interface ValidatedQuestion {
  section: SSection;
  orderInSection: number;
  globalOrder: number;
  text: string;
}

export interface ValidatedSheet {
  parsed: ParsedSheet;
  rows: ValidatedRow[];
  /** Problems that belong to the sheet rather than to any one row (a missing section). */
  messages: string[];
  severity: ImportSeverity;
  /** Empty unless `severity !== 'ERROR'`: a sheet with an error commits nothing. */
  questions: ValidatedQuestion[];
}

function worst(a: ImportSeverity, b: ImportSeverity): ImportSeverity {
  if (a === 'ERROR' || b === 'ERROR') return 'ERROR';
  if (a === 'WARNING' || b === 'WARNING') return 'WARNING';
  return 'OK';
}

/**
 * Stage 3, plus the 5×10 shape check (CQ-1).
 *
 * Nine or eleven questions in a section is an ERROR, not a warning: a version that reached
 * `PUBLISHED` with the wrong shape would make every historical percentage incomparable,
 * and the `total_questions` check constraint would refuse it at the database anyway.
 */
export function validateChecklistSheet(parsed: ParsedSheet): ValidatedSheet {
  const rows: ValidatedRow[] = [];
  const messages: string[] = [];
  let severity: ImportSeverity = 'OK';

  const seenInSection = new Map<string, Set<string>>();
  const seenAnywhere = new Map<string, number>();
  for (const question of parsed.questions) {
    const key = question.text.toLowerCase();
    seenAnywhere.set(key, (seenAnywhere.get(key) ?? 0) + 1);
  }

  let expectedSr = 0;

  for (const question of parsed.questions) {
    const rowMessages: string[] = [...question.notes];
    let rowSeverity: ImportSeverity = question.notes.length > 0 ? 'WARNING' : 'OK';

    if (!question.section) {
      rowMessages.push(
        'This question appears before any "1S – SEIRI" style section header, so its section is unknown',
      );
      rowSeverity = 'ERROR';
    }

    if (question.text.length === 0) {
      rowMessages.push('Check Point is empty');
      rowSeverity = 'ERROR';
    } else if (question.text.length > MAX_QUESTION_TEXT_LENGTH) {
      rowMessages.push(
        `Check Point is ${question.text.length} characters; the limit is ${MAX_QUESTION_TEXT_LENGTH}`,
      );
      rowSeverity = 'ERROR';
    }

    expectedSr += 1;
    if (question.globalOrder !== expectedSr) {
      rowMessages.push(`Sr. is ${question.globalOrder}; expected ${expectedSr} (Sr. must run 1…${TOTAL_QUESTIONS} without gaps)`);
      rowSeverity = 'ERROR';
    }

    if (question.section && question.orderInSection !== null) {
      const sectionIndex = S_SECTION_ORDER.indexOf(question.section);
      const impliedGlobal = sectionIndex * QUESTIONS_PER_SECTION + question.orderInSection;
      if (sectionIndex >= 0 && question.globalOrder !== impliedGlobal) {
        rowMessages.push(
          `Sr. ${question.globalOrder} disagrees with the position in the section, which implies ${impliedGlobal}`,
        );
        rowSeverity = 'ERROR';
      }

      const key = question.text.toLowerCase();
      const withinSection = seenInSection.get(question.section) ?? new Set<string>();
      if (withinSection.has(key)) {
        rowMessages.push('Duplicate Check Point within this section');
        rowSeverity = worst(rowSeverity, 'WARNING');
      } else if ((seenAnywhere.get(key) ?? 0) > 1) {
        rowMessages.push('This Check Point also appears in another section');
        rowSeverity = worst(rowSeverity, 'WARNING');
      }
      withinSection.add(key);
      seenInSection.set(question.section, withinSection);
    }

    severity = worst(severity, rowSeverity);
    rows.push({
      sourceRowNumber: question.sourceRowNumber,
      section: question.section,
      orderInSection: question.orderInSection,
      globalOrder: question.globalOrder,
      text: question.text,
      raw: question.raw,
      severity: rowSeverity,
      messages: rowMessages,
    });
  }

  // CQ-1: five sections, ten questions each, contiguous 1…10.
  for (const section of S_SECTION_ORDER) {
    const inSection = parsed.questions.filter((question) => question.section === section);
    if (!parsed.sectionsSeen.some((seen) => seen.section === section)) {
      messages.push(`Section ${section} is missing from this sheet`);
      severity = 'ERROR';
      continue;
    }
    if (inSection.length !== QUESTIONS_PER_SECTION) {
      messages.push(
        `Section ${section} has ${inSection.length} questions; exactly ${QUESTIONS_PER_SECTION} are required`,
      );
      severity = 'ERROR';
      continue;
    }
    const orders = inSection.map((question) => question.orderInSection);
    const contiguous = orders.every((order, index) => order === index + 1);
    if (!contiguous) {
      messages.push(`Section ${section} order is not contiguous 1…${QUESTIONS_PER_SECTION}`);
      severity = 'ERROR';
    }
  }

  const duplicateSections = parsed.sectionsSeen
    .map((seen) => seen.section)
    .filter((section, index, all) => all.indexOf(section) !== index);
  for (const section of new Set(duplicateSections)) {
    messages.push(`Section ${section} header appears more than once`);
    severity = 'ERROR';
  }

  if (parsed.questions.length !== TOTAL_QUESTIONS) {
    messages.push(
      `This sheet has ${parsed.questions.length} questions; exactly ${TOTAL_QUESTIONS} are required`,
    );
    severity = 'ERROR';
  }

  const questions: ValidatedQuestion[] =
    severity === 'ERROR'
      ? []
      : parsed.questions.map((question) => ({
          section: question.section as SSection,
          orderInSection: question.orderInSection as number,
          globalOrder: question.globalOrder,
          text: question.text,
        }));

  return { parsed, rows, messages, severity, questions };
}

// ------------------------------------------------------- stage 4: DUPLICATE / stage 5

/**
 * The exact bytes stage 4 hashes.
 *
 * Ordered by section then position, so a version that differs only in the order rows
 * happened to be read still hashes the same — and one whose wording changed does not.
 * Hashing itself is left to the caller: `packages/domain` stays free of Node built-ins so
 * the device can run every rule here unchanged.
 */
export function canonicalChecklistSignature(questions: readonly ValidatedQuestion[]): string {
  return [...questions]
    .sort(
      (a, b) =>
        S_SECTION_ORDER.indexOf(a.section) - S_SECTION_ORDER.indexOf(b.section) ||
        a.orderInSection - b.orderInSection,
    )
    .map((question) => `${question.section}|${question.orderInSection}|${question.text}`)
    .join('\n');
}

export interface ComparableQuestion {
  section: SSection;
  orderInSection: number;
  globalOrder: number;
  text: string;
}

/**
 * The side-by-side diff stage 5 shows before anything is written.
 *
 * Matched on (section, position) rather than on text: a reworded question is a change to
 * review, not a delete plus an add that hides which question moved.
 */
export function diffChecklistQuestions(
  current: readonly ComparableQuestion[],
  incoming: readonly ComparableQuestion[],
): ChecklistDiffEntry[] {
  const key = (question: ComparableQuestion) => `${question.section}#${question.orderInSection}`;
  const currentByKey = new Map(current.map((question) => [key(question), question]));
  const incomingByKey = new Map(incoming.map((question) => [key(question), question]));

  const entries: ChecklistDiffEntry[] = [];

  for (const section of S_SECTION_ORDER) {
    const positions = new Set<number>();
    for (const question of [...current, ...incoming]) {
      if (question.section === section) positions.add(question.orderInSection);
    }

    for (const position of [...positions].sort((a, b) => a - b)) {
      const lookup = `${section}#${position}`;
      const before = currentByKey.get(lookup) ?? null;
      const after = incomingByKey.get(lookup) ?? null;

      const change =
        before && after
          ? before.text === after.text
            ? 'UNCHANGED'
            : 'CHANGED'
          : after
            ? 'ADDED'
            : 'REMOVED';

      entries.push({
        section,
        orderInSection: position,
        globalOrder: after?.globalOrder ?? before?.globalOrder ?? 0,
        change,
        currentText: before?.text ?? null,
        incomingText: after?.text ?? null,
      });
    }
  }

  return entries;
}

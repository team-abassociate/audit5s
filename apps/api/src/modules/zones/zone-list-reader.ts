import { zoneCodeForLabel, zoneSortOrder, type CellValue } from '@audit5s/domain';
import { ZONE_LIST_IMPORT_MAX_BYTES } from '@audit5s/contracts';
import { WorkbookReader, WorkbookRejected } from '../checklists/import/workbook-reader';

/**
 * Reads a Unit's Zone list from an Excel workbook or a PDF (R-59).
 *
 * Only three columns are read — Zone No., Zone Name (or Zone Description) and Leader — and
 * found by their headings, so a file carrying more (Location, Sub-Leader, Members, as the
 * Sahney Kirkwood list does) is read for those three and the rest ignored.
 *
 * A PDF has no cells, only positioned text. A row is a Zone number in the Zone No. column;
 * the text of the other two columns belongs to the nearest Zone number above or below it,
 * which is right for a table whose cells are vertically centred, as a spreadsheet printed
 * to PDF is. Column edges are learned from where the text sits, not from the headings'
 * midpoints: a left-aligned Sub-Leader column starts well short of its centred heading.
 */

export interface ImportedZone {
  code: string;
  name: string;
  leaderName: string | null;
  sortOrder: number;
}

export class ZoneListRejected extends Error {}

/** The row as read, before it is checked. `where` names it in an error: "row 4", "page 2". */
interface RawRow {
  zoneNo: string;
  name: string;
  leader: string;
  where: string;
}

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_NAME = 200;
const MAX_ZONES = 500;

const HEADINGS = {
  zoneNo: /^zone\s*(no\.?|number|#|code)?$/i,
  name: /^(zone\s*)?(name|d[ei]s?c?ription|desc)/i,
  leader: /^(zone\s*)?leaders?(\s*name)?$/i,
} as const;
type Column = keyof typeof HEADINGS;
const COLUMNS = Object.keys(HEADINGS) as Column[];

export async function readZoneList(body: Buffer): Promise<ImportedZone[]> {
  if (body.byteLength === 0) throw new ZoneListRejected('The file is empty');
  if (body.byteLength > ZONE_LIST_IMPORT_MAX_BYTES) {
    throw new ZoneListRejected('The file is larger than 5 MB');
  }
  const rows = body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
    ? await readPdf(body)
    : await readWorkbook(body);
  return checkRows(rows);
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function heading(text: string): Column | null {
  const value = clean(text).replace(/[:*]$/, '');
  return COLUMNS.find((column) => HEADINGS[column].test(value)) ?? null;
}

// ------------------------------------------------------------------------------- Excel

async function readWorkbook(body: Buffer): Promise<RawRow[]> {
  let sheets;
  try {
    sheets = await new WorkbookReader().read(body, { maxBytes: ZONE_LIST_IMPORT_MAX_BYTES });
  } catch (error) {
    if (error instanceof WorkbookRejected) {
      throw new ZoneListRejected('Upload an Excel workbook (.xlsx) or a PDF');
    }
    throw error;
  }

  for (const sheet of sheets) {
    const text = (cell: CellValue | undefined) => (cell === null || cell === undefined ? '' : String(cell));
    const headerIndex = sheet.rows.findIndex((row) => headerColumns(row.map(text)) !== null);
    if (headerIndex === -1) continue;
    const columns = headerColumns(sheet.rows[headerIndex]!.map(text))!;
    return sheet.rows.slice(headerIndex + 1).map((row, offset) => ({
      zoneNo: clean(text(row[columns.zoneNo])),
      name: clean(text(row[columns.name])),
      leader: leaderText(text(row[columns.leader]).split(/\r?\n/)),
      where: `row ${headerIndex + offset + 2}`,
    }));
  }
  throw noHeadings();
}

/** Each column's index in a header row, or `null` unless all three are there. */
function headerColumns(cells: string[]): Record<Column, number> | null {
  const found: Partial<Record<Column, number>> = {};
  cells.forEach((cell, index) => {
    const column = heading(cell);
    if (column && found[column] === undefined) found[column] = index;
  });
  return COLUMNS.every((column) => found[column] !== undefined) ? (found as Record<Column, number>) : null;
}

/** "Mr. A\nMs. B" — two people in one cell — reads "Mr. A, Ms. B". */
function leaderText(lines: string[]): string {
  return lines.map(clean).filter(Boolean).join(', ');
}

function noHeadings(): ZoneListRejected {
  return new ZoneListRejected(
    'No heading row with Zone No., Zone Name and Leader was found. Use the Zone list template.',
  );
}

// --------------------------------------------------------------------------------- PDF

interface TextItem {
  text: string;
  left: number;
  right: number;
  /** Baseline, in PDF space: larger is higher on the page. */
  y: number;
}

async function readPdf(body: Buffer): Promise<RawRow[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(body),
    useSystemFonts: false,
    disableFontFace: true,
  });
  let document;
  try {
    document = await task.promise;
  } catch {
    await task.destroy();
    throw new ZoneListRejected('The PDF could not be read');
  }

  const rows: RawRow[] = [];
  let headings: Headings | null = null;
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 50); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item) || clean(item.str) === '') continue;
        const left = item.transform[4] as number;
        items.push({ text: clean(item.str), left, right: left + item.width, y: item.transform[5] as number });
      }
      // A page without its own heading row continues the last one's columns.
      const own = pageHeadings(items);
      if (own) headings = own;
      if (headings) rows.push(...pageRows(own ? items.filter((item) => item.y < own.zoneNo.y - 2) : items, headings, pageNumber));
    }
  } finally {
    await task.destroy();
  }
  if (!headings) throw noHeadings();
  return rows;
}

/** The three read headings, and every heading on their line: the others bound the columns. */
type Headings = Record<Column, TextItem> & { line: TextItem[] };

function pageHeadings(items: TextItem[]): Headings | null {
  for (const candidate of items) {
    if (heading(candidate.text) !== 'zoneNo') continue;
    const line = items.filter((item) => Math.abs(item.y - candidate.y) < 3);
    const found: Partial<Record<Column, TextItem>> = {};
    for (const item of line) {
      const column = heading(item.text);
      if (column && !found[column]) found[column] = item;
    }
    if (COLUMNS.every((column) => found[column])) return { ...(found as Record<Column, TextItem>), line };
  }
  return null;
}

/** `items` are the page's text below its heading row. */
function pageRows(items: TextItem[], headings: Headings, pageNumber: number): RawRow[] {
  const anchors = items
    .filter((item) => item.left < headings.zoneNo.right + 10 && item.right > headings.zoneNo.left - 10)
    .sort((a, b) => b.y - a.y);
  if (anchors.length === 0) return [];

  // Each Zone number owns the text from halfway to the one above to halfway to the one below;
  // the first reaches up to the heading row (or the page top), the last as far down as up.
  const top = Math.max(...items.map((item) => item.y)) + 1;
  const bands = anchors.map((anchor, index) => {
    const above = index === 0 ? Math.min(top, anchor.y + 200) : (anchors[index - 1]!.y + anchor.y) / 2;
    const below =
      index === anchors.length - 1 ? anchor.y - (above - anchor.y) : (anchor.y + anchors[index + 1]!.y) / 2;
    return { anchor, above, below };
  });
  const inBand = (item: TextItem) => bands.find((band) => item.y <= band.above && item.y > band.below);
  const banded = items.filter((item) => inBand(item));
  const edges = columnEdges(banded, headings.line);
  const columnOf = (item: TextItem) => {
    const centre = (item.left + item.right) / 2;
    return COLUMNS.find((column) => centre >= edges[column][0] && centre < edges[column][1]) ?? null;
  };

  const cells = new Map(bands.map((band) => [band, { zoneNo: [], name: [], leader: [] } as Record<Column, TextItem[]>]));
  for (const item of banded) {
    const column = columnOf(item);
    if (column) cells.get(inBand(item)!)![column].push(item);
  }
  return bands.map((band) => ({
    zoneNo: clean(band.anchor.text),
    name: lines(cells.get(band)!.name).join(' '),
    leader: leaderText(lines(cells.get(band)!.leader)),
    where: `page ${pageNumber}, ${clean(band.anchor.text)}`,
  }));
}

/** A cell's text, top to bottom, with the pieces of one line joined left to right. */
function lines(cell: TextItem[]): string[] {
  const sorted = [...cell].sort((a, b) => b.y - a.y || a.left - b.left);
  const out: TextItem[][] = [];
  for (const item of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last[0]!.y - item.y) < 2) last.push(item);
    else out.push([item]);
  }
  return out.map((line) => line.map((item) => item.text).join(' '));
}

/**
 * Where each read column starts and ends on the page.
 *
 * Between two neighbouring headings, the edge is in the first gutter right of the left
 * heading's centre: past any text covering that centre — a centred column's always does —
 * to the next text that starts clear of it. A heading's midpoint would not do: a left-aligned
 * Sub-Leader column starts well short of its centred heading, and would read as Leader.
 */
function columnEdges(items: TextItem[], line: TextItem[]): Record<Column, [number, number]> {
  const sorted = [...line].sort((a, b) => a.left - b.left);
  const centre = (item: TextItem) => (item.left + item.right) / 2;
  const edgeBetween = (a: TextItem, b: TextItem) => {
    const to = centre(b);
    let cursor = centre(a);
    const spans = items
      .filter((item) => item.right > cursor && item.left < to)
      .sort((x, y) => x.left - y.left);
    for (const span of spans) {
      if (span.left > cursor + 1) return (cursor + span.left) / 2;
      cursor = Math.max(cursor, span.right);
    }
    return cursor < to ? (cursor + to) / 2 : (a.right + b.left) / 2;
  };

  const edges = {} as Record<Column, [number, number]>;
  for (const column of COLUMNS) {
    const index = sorted.findIndex((item) => heading(item.text) === column);
    const self = sorted[index]!;
    const before = sorted[index - 1];
    const after = sorted[index + 1];
    edges[column] = [
      before ? edgeBetween(before, self) : -Infinity,
      after ? edgeBetween(self, after) : Infinity,
    ];
  }
  return edges;
}

// ------------------------------------------------------------------------------ Checks

function checkRows(rows: RawRow[]): ImportedZone[] {
  const problems: string[] = [];
  const zones: ImportedZone[] = [];
  const seen = new Map<string, string>();

  for (const row of rows) {
    // A number alone is a template row nobody filled in, not a Zone.
    if (!row.name && !row.leader) continue;
    const label = row.zoneNo.replace(/^zone\s*(no\.?)?\s*[-:#.]?\s*/i, '').replace(/^z-/i, '');
    const code = zoneCodeForLabel(label);
    if (!code) {
      problems.push(
        row.zoneNo
          ? `${row.where}: "${row.zoneNo}" is not a Zone number like 7 or 1A`
          : `${row.where}: the Zone number is missing`,
      );
      continue;
    }
    if (seen.has(code)) {
      problems.push(`${row.where}: Zone ${label} is listed twice (also ${seen.get(code)})`);
      continue;
    }
    seen.set(code, row.where);
    const name = row.name || `Zone ${label.replace(/^0+(?=.)/, '').toUpperCase()}`;
    if (name.length > MAX_NAME || row.leader.length > MAX_NAME) {
      problems.push(`${row.where}: the Zone name or leader is longer than ${MAX_NAME} characters`);
      continue;
    }
    zones.push({ code, name, leaderName: row.leader || null, sortOrder: zoneSortOrder(label) });
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join('; ');
    throw new ZoneListRejected(
      problems.length > 10 ? `${shown}; and ${problems.length - 10} more` : shown,
    );
  }
  if (zones.length === 0) throw new ZoneListRejected('The file lists no Zones');
  if (zones.length > MAX_ZONES) throw new ZoneListRejected(`The file lists more than ${MAX_ZONES} Zones`);
  return zones;
}

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readZoneList, ZoneListRejected } from './zone-list-reader';

/** A one-page PDF of Helvetica text, each piece at its own x and y. */
function pdfWith(pieces: Array<[text: string, x: number, y: number]>): Buffer {
  const stream = pieces
    .map(([text, x, y]) => `BT /F1 9 Tf ${x} ${y} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1190 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('readZoneList', () => {
  it('reads Zone No., Zone Name and Leader from a printed table, ignoring the other columns', async () => {
    const pdf = pdfWith([
      ['Location', 60, 750],
      ['Zone No.', 170, 750],
      ['Zone Name', 300, 750],
      ['Leader', 480, 750],
      ['Sub-Leader', 700, 750],
      ['Members', 950, 750],
      // Zone 01: one line each; its Sub-Leader cell is left-aligned, close to Leader's.
      ['Unit 1', 60, 700],
      ['Zone 01', 172, 700],
      ['Maintenance Room', 285, 700],
      ['Mr. A. Sharma', 465, 700],
      ['Mr. K. Pal', 560, 713],
      ['Mr. Yogesh Patil', 560, 700],
      ['Mr. Dnyandev Barhate', 560, 687],
      ['All trainees', 900, 700],
      // Zone 02: a name and two leaders over two lines, centred on the Zone number.
      ['Zone 02', 172, 640],
      ['Quality (In-process) &', 280, 646],
      ['Inspection Room', 295, 634],
      ['Mr. B. Rao', 470, 646],
      ['Mr. C. Das', 470, 634],
      ['Mr. D. Joshi (Lab area)', 560, 640],
      ['Company | Zone Wise Leader List', 440, 40],
    ]);

    const room = 'Quality (In-process) & Inspection Room';
    expect((await readZoneList(pdf)).zones).toEqual([
      { code: 'Z-01', name: 'Maintenance Room', leaderName: 'Mr. A. Sharma', leaderPhone: null, sortOrder: 1 },
      // R-63: two leaders, two subzones.
      { code: 'Z-2A', name: room, leaderName: 'Mr. B. Rao', leaderPhone: null, sortOrder: 2 },
      { code: 'Z-2B', name: room, leaderName: 'Mr. C. Das', leaderPhone: null, sortOrder: 2 },
    ]);
  });

  it('reads the template workbook, skipping rows only numbered', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Table 1');
    sheet.addRow(['Name Of Your Unit']);
    sheet.addRow(['Zone No.', 'Zone Discription(Name)', 'Leader', 'Members']);
    sheet.addRow(['Zone 01', 'Press Pit', 'Mr. A\nMs. B', 'Everyone']);
    sheet.addRow([7, 'Canteen', '']);
    sheet.addRow(['Zone 08', '', '']);

    expect(await readZoneList(Buffer.from(await book.xlsx.writeBuffer()))).toEqual({
      zones: [
        { code: 'Z-1A', name: 'Press Pit', leaderName: 'Mr. A', leaderPhone: null, sortOrder: 1 },
        { code: 'Z-1B', name: 'Press Pit', leaderName: 'Ms. B', leaderPhone: null, sortOrder: 1 },
        { code: 'Z-07', name: 'Canteen', leaderName: null, leaderPhone: null, sortOrder: 7 },
      ],
      notes: [],
    });
  });

  it('reads Mobile No., one number per leader in order, and notes a row it cannot pair', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Table 1');
    sheet.addRow(['Zone No.', 'Zone Name', 'Leader', 'Mobile No.']);
    sheet.addRow(['Zone 01', 'Press Pit', 'Mr. A. Sharma', 9876543210]);
    sheet.addRow(['Zone 02', 'Boiler', 'Ms. B. Rao / Mr. C. Das', '+91 98765-43211\n09876543212']);
    sheet.addRow(['Zone 03', 'Stores', 'Mr. D. Patil', '12345']);
    // As the owner's sample sheet writes two people: one line, wrapped by the column width.
    sheet.addRow(['Zone 6', 'Dispatch', 'Mr. Sunil Gaikwad Ms. Deepali Sawadekar', '9876543216 / 9876543217']);
    sheet.addRow(['Zone 04', 'Canteen', 'Mr. E\nMr. F', '9876543213']);
    sheet.addRow(['Zone 5A', 'Gate', 'Mr. G, Mr. H', '9876543214, 9876543215']);

    const { zones, notes } = await readZoneList(Buffer.from(await book.xlsx.writeBuffer()));
    expect(zones.map((zone) => [zone.code, zone.leaderName, zone.leaderPhone])).toEqual([
      ['Z-01', 'Mr. A. Sharma', '9876543210'],
      ['Z-2A', 'Ms. B. Rao', '9876543211'],
      ['Z-2B', 'Mr. C. Das', '9876543212'],
      ['Z-03', 'Mr. D. Patil', null],
      ['Z-6A', 'Mr. Sunil Gaikwad', '9876543216'],
      ['Z-6B', 'Ms. Deepali Sawadekar', '9876543217'],
      ['Z-4A', 'Mr. E', null],
      ['Z-4B', 'Mr. F', null],
      ['Z-5A', 'Mr. G, Mr. H', null],
    ]);
    expect(notes).toEqual([
      'row 4: "12345" is not a 10-digit mobile number, so no account was made for it',
      'row 6: 2 leader(s) but 1 mobile numbers, so no account was made',
      'row 7: Zone 5A names 2 leaders but is already a subzone, so no account was made',
    ]);
  });

  it('reads a printed Mobile No. column, a number a line beside its leader', async () => {
    const pdf = pdfWith([
      ['Zone No.', 170, 750],
      ['Zone Name', 300, 750],
      ['Leader', 480, 750],
      ['Mobile No.', 650, 750],
      ['Zone 01', 172, 700],
      ['Press', 300, 700],
      ['Mr. A. Sharma', 465, 706],
      ['Ms. B. Rao', 465, 694],
      ['9876543210', 640, 706],
      ['9876543211', 640, 694],
    ]);
    expect((await readZoneList(pdf)).zones.map((zone) => [zone.code, zone.leaderName, zone.leaderPhone])).toEqual([
      ['Z-1A', 'Mr. A. Sharma', '9876543210'],
      ['Z-1B', 'Ms. B. Rao', '9876543211'],
    ]);
  });

  it('names every row it cannot read', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Zones');
    sheet.addRow(['Zone No', 'Zone Name', 'Leader']);
    sheet.addRow(['Zone 01', 'Press Pit', '']);
    sheet.addRow(['1', 'Press Pit again', '']);
    sheet.addRow(['', 'Unnumbered', '']);

    await expect(readZoneList(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow(
      'row 3: Zone 1 is listed twice (also row 2); row 4: the Zone number is missing',
    );
  });

  it('refuses a file that is neither a workbook nor a PDF', async () => {
    await expect(readZoneList(Buffer.from('Zone No.,Zone Name,Leader'))).rejects.toBeInstanceOf(ZoneListRejected);
  });
});

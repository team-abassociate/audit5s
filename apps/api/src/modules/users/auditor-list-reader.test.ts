import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { AuditorListRejected, readAuditorList } from './auditor-list-reader';

const TEMPLATE = join(__dirname, '../../../../admin-web/public/auditor-list-template.xlsx');

describe('readAuditorList', () => {
  it('reads each Zone’s leaders and the ad hoc auditors from the template, skipping its blank rows', async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(TEMPLATE);
    const sheet = book.worksheets[0]!;
    // Zone 01 ZL1 and ZL2, Zone 02 ZL1, then the first ad hoc auditor row.
    sheet.getRow(3).getCell(3).value = 'Mr. A. Sharma';
    sheet.getRow(3).getCell(4).value = 9876543210;
    sheet.getRow(4).getCell(3).value = 'Ms. B. Rao';
    sheet.getRow(4).getCell(4).value = '+91 98765-43211';
    sheet.getRow(6).getCell(3).value = 'Mr. C. Das';
    sheet.getRow(6).getCell(4).value = '12345';
    sheet.getRow(93).getCell(3).value = 'Dr. External Auditor';
    sheet.getRow(93).getCell(4).value = '09876543213';

    expect(await readAuditorList(Buffer.from(await book.xlsx.writeBuffer()))).toEqual({
      auditors: [
        { name: 'Mr. A. Sharma', phone: '9876543210' },
        { name: 'Ms. B. Rao', phone: '9876543211' },
        { name: 'Dr. External Auditor', phone: '9876543213' },
      ],
      notes: ['Zone 2 ZL1: "12345" is not a 10-digit mobile number, so Mr. C. Das has no account'],
    });
  });

  it('refuses a file without Name and Mobile No. headings, and one listing nobody', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Zones').addRow(['Zone No.', 'Zone Name', 'Leader']);
    await expect(readAuditorList(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow(/Name and Mobile No/);

    const template = readFileSync(TEMPLATE);
    await expect(readAuditorList(template)).rejects.toThrow('The file lists nobody');
    await expect(readAuditorList(Buffer.from('%PDF-1.4'))).rejects.toBeInstanceOf(AuditorListRejected);
  });
});

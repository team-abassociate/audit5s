import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  formatAge,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatTime,
  formatWeekdayDate,
  istDateKey,
  NO_DATE,
} from './datetime';

describe('formatDateTime (R-39(d) as amended: 12-hour, IST)', () => {
  it('prints the owner’s example, converted from UTC to IST', () => {
    // 08:35 UTC is 2:05 PM in India.
    expect(formatDateTime('2026-09-30T08:35:00.000Z')).toBe('30 Sept 2026, 2:05 PM');
  });

  it('drops seconds rather than rounding them up', () => {
    expect(formatDateTime('2026-09-30T08:35:59.999Z')).toBe('30 Sept 2026, 2:05 PM');
  });

  it('reads midnight IST as 12 AM, on the IST day', () => {
    // 18:30 UTC on the 30th is 00:00 IST on 1 Oct.
    expect(formatDateTime('2026-09-30T18:30:00.000Z')).toBe('01 Oct 2026, 12:00 AM');
    expect(formatDateTime('2026-09-30T18:35:00.000Z')).toBe('01 Oct 2026, 12:05 AM');
  });

  it('reads noon IST as 12 PM, and the minute before as AM', () => {
    expect(formatDateTime('2026-09-30T06:30:00.000Z')).toBe('30 Sept 2026, 12:00 PM');
    expect(formatDateTime('2026-09-30T06:29:00.000Z')).toBe('30 Sept 2026, 11:59 AM');
    expect(formatDateTime('2026-09-30T18:29:00.000Z')).toBe('30 Sept 2026, 11:59 PM');
  });

  it('crosses the year boundary in IST, not UTC', () => {
    // 31 Dec 20:00 UTC is already 1 Jan in India.
    expect(formatDateTime('2026-12-31T20:00:00.000Z')).toBe('01 Jan 2027, 1:30 AM');
    expect(formatDate('2026-12-31T18:29:00.000Z')).toBe('31 Dec 2026');
    expect(formatDate('2026-12-31T18:30:00.000Z')).toBe('01 Jan 2027');
  });

  it('does not depend on the machine’s time zone', () => {
    // A Date, a number and a string for one instant all print the same.
    const iso = '2026-03-07T06:00:00.000Z';
    const expected = '07 Mar 2026, 11:30 AM';
    expect(formatDateTime(iso)).toBe(expected);
    expect(formatDateTime(new Date(iso))).toBe(expected);
    expect(formatDateTime(Date.parse(iso))).toBe(expected);
  });

  it('accepts an offset timestamp and reads it in IST', () => {
    expect(formatDateTime('2026-09-30T14:05:00+05:30')).toBe('30 Sept 2026, 2:05 PM');
  });

  it('prints a dash for null, undefined, empty and nonsense', () => {
    for (const missing of [null, undefined, '', 'not a date']) {
      expect(formatDateTime(missing)).toBe(NO_DATE);
      expect(formatDate(missing)).toBe(NO_DATE);
      expect(formatDayMonth(missing)).toBe(NO_DATE);
      expect(formatTime(missing)).toBe(NO_DATE);
    }
    expect(NO_DATE).toBe('—');
  });
});

describe('the shorter forms', () => {
  it('names every month the en-IN way: three letters, but Sept', () => {
    const months = Array.from({ length: 12 }, (_, month) =>
      formatDayMonth(Date.UTC(2026, month, 15, 6, 0)),
    );
    expect(months).toEqual([
      '15 Jan', '15 Feb', '15 Mar', '15 Apr', '15 May', '15 Jun',
      '15 Jul', '15 Aug', '15 Sept', '15 Oct', '15 Nov', '15 Dec',
    ]);
  });

  it('formatTime is the clock alone', () => {
    expect(formatTime('2026-09-30T03:35:00.000Z')).toBe('9:05 AM');
    expect(formatTime('2026-09-30T18:30:00.000Z')).toBe('12:00 AM');
  });

  it('formatWeekdayDate names the IST weekday', () => {
    expect(formatWeekdayDate('2026-09-30T08:35:00.000Z')).toBe('Wed, 30 Sept 2026');
    // 20:00 UTC on Wednesday is already Thursday in India.
    expect(formatWeekdayDate('2026-09-30T20:00:00.000Z')).toBe('Thu, 01 Oct 2026');
    expect(formatWeekdayDate(null)).toBe(NO_DATE);
  });

  it('istDateKey groups by the IST day and round-trips through a heading', () => {
    expect(istDateKey('2026-09-30T18:29:00.000Z')).toBe('2026-09-30');
    expect(istDateKey('2026-09-30T18:30:00.000Z')).toBe('2026-10-01');
    expect(istDateKey('2026-12-31T20:00:00.000Z')).toBe('2027-01-01');
    expect(istDateKey(undefined)).toBeNull();
    expect(formatWeekdayDate(`${istDateKey('2026-09-30T08:35:00.000Z')}T12:00:00+05:30`)).toBe(
      'Wed, 30 Sept 2026',
    );
  });

  it('formatDate pads the day so a column lines up', () => {
    expect(formatDate('2026-10-01T06:00:00.000Z')).toBe('01 Oct 2026');
  });
});

describe('ages, in IST calendar days', () => {
  const now = '2026-10-03T06:00:00.000Z'; // 11:30 AM IST, 3 Oct

  it('counts calendar days, not 24-hour blocks', () => {
    // 11 PM IST on 2 Oct is one day old at 11:30 AM on 3 Oct.
    expect(daysBetween('2026-10-02T17:30:00.000Z', now)).toBe(1);
    // 1 AM IST on 3 Oct (19:30 UTC on 2 Oct) is today.
    expect(daysBetween('2026-10-02T19:30:00.000Z', now)).toBe(0);
    expect(daysBetween('2026-09-24T06:00:00.000Z', now)).toBe(9);
  });

  it('is never negative and is null when an end is missing', () => {
    expect(daysBetween('2026-10-05T06:00:00.000Z', now)).toBe(0);
    expect(daysBetween(null, now)).toBeNull();
    expect(daysBetween('2026-10-01T06:00:00.000Z', null)).toBeNull();
  });

  it('formatAge says it in words', () => {
    expect(formatAge('2026-10-03T01:00:00.000Z', now)).toBe('today');
    expect(formatAge('2026-10-02T06:00:00.000Z', now)).toBe('1 day');
    expect(formatAge('2026-09-24T06:00:00.000Z', now)).toBe('9 days');
    expect(formatAge(null, now)).toBe(NO_DATE);
  });

  it('defaults to now', () => {
    expect(daysBetween(Date.now())).toBe(0);
    expect(formatAge(Date.now())).toBe('today');
  });
});

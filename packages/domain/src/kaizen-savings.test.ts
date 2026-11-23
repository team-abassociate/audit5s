import { describe, expect, it } from 'vitest';
import { KAIZEN_SAVING_TYPES, type KaizenSavingLine } from '@audit5s/contracts';
import { calcSavingLine, missingSavingInputs, newSavingLine, savingSummary, savingTotals, savingsText, type SavingResult } from './kaizen-savings';

// Ported from the Kaizen Sheet Maker's tests/calc.test.js: the formulas against the plants' own Kaizen sheets.
type Values = Record<string, string | number>;
const calc = (line: { type: string; values: Values }): SavingResult => calcSavingLine(line as KaizenSavingLine)!;
const year = (type: string, values: Values) => Math.round(calc({ type, values }).year);
const eq = (a: unknown, b: unknown) => expect(a).toBe(b);
const expect_deep = (a: unknown, b: unknown) => expect(a).toEqual(b);
const ok = (a: unknown, _msg?: string) => expect(a).toBeTruthy();

describe('kaizen savings calculator', () => {
  it('matches the plant sheets', () => {
    // Movable Rack: 2 hr × 2 operators, Rs 800 on a 12-hr shift, 26 days → Rs 83,200
    eq(year('manpower', { t: 2, tUnit: 'hr', ops: 2, wage: 800, shift: 12, days: 26 }), 83200);
    // Kaizen 02 corrected: 25 min, Rs 600 on an 8-hr shift, 26 days → Rs 9,750
    eq(year('manpower', { t: 25, tUnit: 'min', ops: 1, wage: 600, shift: 8, days: 26 }), 9750);
    // Kaizen 01: 45 min, Rs 400 on a 9-hr shift, 25 days → Rs 10,000 (sheet shows 9,900 because Rs 44.44/hr was rounded to 44)
    eq(year('manpower', { t: 45, tUnit: 'min', ops: 1, wage: 400, shift: 9, days: 25 }), 10000);
    // Kaizen 03: 1 manpower released (full 9-hr shift), Rs 600/day, 26 days → Rs 1,87,200
    eq(year('manpower', { t: 9, tUnit: 'hr', ops: 1, wage: 600, shift: 9, days: 26 }), 187200);
    // PLC: 15 rejections × Rs 15,000 → Rs 27,00,000; payback 3.7 months on Rs 8,40,000
    const plc = calc({ type: 'rejection', values: { before: 15, after: 0, cost: 15000, inv: 840000 } });
    eq(Math.round(plc.year), 2700000); eq(plc.payback.toFixed(1), '3.7');
    // Kaizen 07: scrap sold for Rs 10.5 lakh is one-time, never × 12
    const scrap = calc({ type: 'other', values: { desc: 'scrap sold', freq: 'once', monthly: 1050000, kind: 'hard' } });
    eq(scrap.once, 1050000); eq(scrap.year, 0);
    eq(savingTotals([scrap]).oneTime, 1050000);
    // Safety: could happen 2 times a year before, 0 after; no wage → no rupees, just the count
    const s = calc({ type: 'safety', values: { sev: 4, nb: 2, na: 0 } });
    eq(s.times.drop, 2); eq(s.avoided, 0);
    // older safety lines (1–5 likelihood) are converted to times a year: likely (4) → once a year, rare (1) → 0.02
    const old = calc({ type: 'safety', values: { sev: 3, lb: 4, la: 1 } });
    eq(old.times.before, 1); eq(old.times.after, 0.02);
    // --- types added from the second batch of plant sheets ---
    // Dhanashree die: 12 → 1 min × 200 nos/month at Rs 100/hr → Rs 3,667/month, Rs 44,000/year
    eq(year('jobtime', { tb: 12, ta: 1, jUnit: 'min', qty: 200, rate: 100 }), 44000);
    // Powerinst DU bush: 26 → 14 sec × 3000 coils/month at Rs 69/hr → Rs 8,280/year (sheet: 8280)
    eq(year('jobtime', { tb: 26, ta: 14, jUnit: 'sec', qty: 3000, rate: 69 }), 8280);
    // Dhanashree Tsunami: 2 persons × Rs 600 × 26 days → Rs 3,74,400 (sheet wrote Rs 1,87,200 for the same formula)
    eq(year('headcount', { persons: 2, wage: 600, days: 26 }), 374400);
    // Dhanashree storage: 36 sq m at Rs 25/sq ft → 387.5 sq ft → Rs 1,16,250/year, soft unless chosen hard
    const sp = calc({ type: 'space', values: { area: 36, areaUnit: 'sqm', rent: 25, kind: 'soft' } });
    eq(Math.round(sp.year), 116250); eq(sp.cls, 'soft');
    // Entech Stellite: Rs 11,550 → Rs 6,640 per plug × 3 plugs, one lot → Rs 14,730 one-time
    const st = calc({ type: 'unitcost', values: { desc: '8" plug', cb: 11550, ca: 6640, qty: 3, freq: 'once' } });
    eq(st.once, 14730); eq(st.year, 0);
    // per-year quantity is spread over 12 months, not multiplied again
    eq(year('unitcost', { cb: 810, ca: 790, qty: 804, freq: 'year' }), 16080);
    // new lines get their unit defaults
    eq(newSavingLine('jobtime').values.jUnit, 'sec'); eq(newSavingLine('manpower').values.tUnit, 'hr');
    // Vidyut PLC sheet: net first year = 27,00,000 − 8,40,000
    ok(plc.working.some(w => w.includes('Rs 18,60,000')));

    // --- third round: the 8 wastes, environment, safety in rupees ---
    // rejection with only the selling price known: 75% of Rs 500 = Rs 375 lost per job; 10 jobs/month
    eq(year('rejection', { before: 10, after: 0, cost: '', sp: 500 }), 45000);
    expect_deep(missingSavingInputs(<KaizenSavingLine>{ type: 'rejection', values: { before: 10, after: 0, cost: '', sp: '' } }), ['Cost price or selling price per job']);
    // electricity: a 40 W bulb run 1 hr instead of 2 hr, 26 days, Rs 9/kWh → 0.04 kWh/day
    const bulb = calc({ type: 'electricity', values: { lb: 40, la: 40, loadUnit: 'W', hb: 2, ha: 1, days: 26, tariff: 9 } });
    eq(+bulb.year.toFixed(2), 112.32);
    // electricity saved by an older version (kW reduced × hours) still gives the same number
    eq(year('electricity', { kw: 2, hrs: 8, days: 26, tariff: 9 }), 44928);
    // material: 1 kg → 0.5 kg per piece, 10 pieces, Rs 200/kg; recurring vs one time
    eq(year('material', { mb: 1, ma: 0.5, qtyUnit: 'kg', pcs: 10, price: 200, freq: 'month' }), 12000);
    eq(calc({ type: 'material', values: { mb: 1, ma: 0.5, pcs: 10, price: 200, freq: 'once' } }).once, 1000);
    eq(year('material', { qty: 2, qtyUnit: 'kg', price: 100, days: 26 }), 62400); // older version: 2 kg/day saved
    // scrap (KZ-004 tandem press): 187.5 kg/month at Rs 500; disposal Rs 35 adds, a sale price of Rs 35 takes off
    const kz4 = { mb: 2, ma: 1.9, qtyUnit: 'kg', pcs: 1875, price: 500, srate: 35, freq: 'month' };
    eq(year('material', { ...kz4, scrap: 'pay' }), 187.5 * 535 * 12);
    eq(year('material', { ...kz4, scrap: 'sell' }), 187.5 * 465 * 12);
    eq(year('material', { ...kz4, scrap: 'none' }), 187.5 * 500 * 12);
    eq(year('material', { ...kz4, scrap: undefined }), 187.5 * 500 * 12); // lines saved before the scrap choice
    // motion: 3 sec × 100 times a day, Rs 600 / 8 hr, 26 days
    eq(+calc({ type: 'motion', values: { ms: 3, mn: 100, ops: 1, wage: 600, shift: 8, days: 26 } }).year.toFixed(2), 1950);
    // waiting: 4 hr (half shift) → 0, 1 operator at Rs 600/day → Rs 300 a day
    eq(year('waiting', { wb: 4, wa: 0, tUnit: 'hr', ops: 1, wage: 600, shift: 8, days: 26 }), 93600);
    // processing cost Rs 500 → Rs 400 per piece (60 → 45 min at Rs 400/hr + Rs 100 consumables), 1000 pcs/month
    eq(year('process', { ctb: 60, cta: 45, cUnit: 'min', lrate: 100, mrate: 300, cnb: 100, cna: 100, pcs: 1000, kind: 'soft' }), 1200000);
    // overprocessing: 2 extra CNC minutes + 0.1 kg at Rs 200 + Rs 5 tooling per piece, 1000 pcs
    eq(year('overproc', { xt: 2, cUnit: 'min', mrate: 300, lrate: 100, xm: 0.1, xmr: 200, xc: 5, pcs: 1000, kind: 'hard' }), 460000);
    // overproduction: 200 pcs × 5 min at Rs 400/hr + Rs 1 lakh excess stock at 20%
    eq(year('overprod', { pcs: 200, tpp: 5, cUnit: 'min', lrate: 100, mrate: 300, stock: 100000, icc: 20, kind: 'hard' }), 100000);
    // inventory: Rs 10 lakh → 5 lakh at 10% (the loan example) → Rs 50,000 a year
    eq(year('inventory', { vb: 1000000, va: 500000, icc: 10, kind: 'hard' }), 50000);
    // OTD: 10 → 6 days, 300 days a year: 30 → 50 consignments, Rs 10,000 profit each
    eq(year('otd', { ltb: 10, lta: 6, dy: 300, profit: 10000, kind: 'soft' }), 200000);
    // environment: diesel 100 → 80 litres a month at Rs 90 → Rs 21,600; 0.64 t CO2
    const dg = calc({ type: 'environment', values: { rb: 100, ra: 80, res: 'diesel', rate: 90, kind: 'hard' } });
    eq(Math.round(dg.year), 21600); ok(dg.working.some(w => w.includes('0.64 tonnes')));
    // safety: hand amputation (sev 4, 60%), age 30, wage Rs 15,000, 30 days off, Rs 1 lakh medical, indirect 1×, once a year → never
    // full compensation = 60% × 15,000 × 207.98 = 18,71,820; × 60% = 11,23,092
    const fan = calc({ type: 'safety', values: { sev: 4, nb: 1, na: 0, wage: 15000, age: 30, loss: 60, off: 30, med: 100000, esi: 'no', ind: 1 } });
    eq(Math.round(fan.cost), 2480799); eq(Math.round(fan.avoided), 2480799);
    eq(fan.year, 0); eq(Math.round(savingTotals([fan]).avoided), 2480799);
    // ESI-covered: compensation left out; no wage: risk only, no rupees
    eq(Math.round(calc({ type: 'safety', values: { sev: 4, nb: 1, na: 0, wage: 15000, age: 30, loss: 60, off: 30, med: 100000, esi: 'yes', ind: 1 } }).cost), 234615);
    eq(calc({ type: 'safety', values: { sev: 3, nb: 0.5, na: 0, wage: '' } }).avoided, 0);
    // every type builds a default line that calculates
    for (const t of KAIZEN_SAVING_TYPES) ok(calcSavingLine(newSavingLine(t)), t);
  });

  it('returns null while a required input is missing', () => {
    expect(calcSavingLine({ type: 'manpower', values: { t: '', ops: 1, wage: 800, shift: 8, days: 26 } })).toBeNull();
  });

  it('flags a loss and an over-long day', () => {
    expect(calc({ type: 'jobtime', values: { tb: 10, ta: 20, jUnit: 'sec', qty: 10, rate: 100 } }).warn).toMatch(/loss/);
    expect(calc({ type: 'manpower', values: { t: 10, tUnit: 'hr', ops: 1, wage: 800, shift: 8, days: 26 } }).warn).toMatch(/shift/);
    expect(calc({ type: 'waiting', values: { wb: 1, wa: 2, tUnit: 'hr', ops: 1, wage: 600, shift: 8, days: 26 } }).warn).toMatch(/loss/);
    expect(calc({ type: 'otd', values: { ltb: 0, lta: 6, dy: 300, profit: 10000, kind: 'soft' } }).warn).toMatch(/more than 0/);
    expect(calc({ type: 'safety', values: { sev: 4, nb: 1, na: 0, wage: 15000, age: 30, loss: '', esi: 'no', ind: 1 } }).warn).toMatch(/loss of earning/);
  });

  it('sums the sheet: hard + soft a year, investment, one-time and safety apart', () => {
    const lines: KaizenSavingLine[] = [
      { type: 'manpower', values: { t: 2, tUnit: 'hr', ops: 2, wage: 800, shift: 12, days: 26, inv: 5000 } },
      { type: 'rejection', values: { before: 15, after: 0, cost: 15000, inv: 840000 } },
      { type: 'other', values: { desc: 'scrap sold', freq: 'once', monthly: 1050000, kind: 'hard' } },
      { type: 'safety', values: { sev: 5, nb: 0.5, na: 0, wage: 20000, age: 40, off: 0, med: 0, esi: 'no', ind: 1, inv: 2000 } },
    ];
    const summary = savingSummary(lines)!;
    expect(summary.annualSaving).toBe(83200 + 2700000);
    expect(summary.implementationCost).toBe(5000 + 840000 + 2000);
    expect(summary.working).toContain('Total annual saving = Rs 27,83,200 (hard Rs 27,00,000 + soft Rs 83,200)');
    expect(summary.working).toContain('One-time benefit = Rs 10,50,000');
    expect(summary.working).toContain('Safety cost avoided');
    expect(summary.working).toContain('wage capped');
  });

  it('has nothing to say about an empty or unfinished calculation', () => {
    expect(savingSummary([{ type: 'manpower', values: {} }])).toBeNull();
    expect(savingsText([null])).toBe('');
  });

  it('never fills a negative saving', () => {
    expect(savingSummary([{ type: 'jobtime', values: { tb: 10, ta: 20, jUnit: 'sec', qty: 10, rate: 100 } }])!.annualSaving).toBe(0);
  });

  it('offers no figure the sheet cannot hold: a 0 shift divides by zero, a huge one overflows', () => {
    const manpower = (values: Values) => savingSummary([{ type: 'manpower', values } as KaizenSavingLine]);
    expect(manpower({ t: 1, ops: 1, wage: 800, shift: 0, days: 26 })).toBeNull();
    expect(manpower({ t: 0, ops: 1, wage: 800, shift: 0, days: 26 })).toBeNull();
    expect(manpower({ t: 1e12, ops: 1e6, wage: 1e6, shift: 1, days: 31 })).toBeNull();
  });
});

// The sample Kaizens on staging (Insumat, Nov 2026): each one now goes in as the sheet states it, with no working by hand.
describe('sample Kaizens enter as written', () => {
  it('matches the annual saving on each sheet', () => {
    eq(year('unitcost', { cb: 50, ca: 25, qty: 3000, freq: 'month' }), 900000); // Press 01: Rs 50 → 25 a sheet, 3,000 sheets
    const out = { mode: 'output', days: 25, rate: 1000 };
    eq(year('jobtime', { ...out, ob: 45, oa: 60, runh: 7 }), 700000); // Press 02: 45 → 60 sheets a cycle, 7 one-hour cycles (sheet rounds to 6,99,900)
    eq(year('jobtime', { ...out, ob: 3, oa: 4, runh: 24 }), 2400000); // Press 04: 3 → 4 cycles in 24 hours
    eq(year('jobtime', { ...out, ob: 75, oa: 90, runh: 22 }), 1320000); // VT 03: 75 → 90 metres an hour, 22 hr a day
    eq(year('jobtime', { mode: 'hours', hrs: 8, rate: 1000 }), 96000); // VT 01 / 02: 8 hours a month (the sheets say 72,000: 8,000 × 12 is 96,000)
    eq(year('material', { basis: 'total', qs: 187.5, qtyUnit: 'kg', price: 500, scrap: 'pay', srate: 35, freq: 'month' }), 1203750); // Press 03
    const hr = { wUnit: 'hr', wage: 100, days: 25, tUnit: 'min' };
    eq(year('manpower', { ...hr, t: 5, times: 10, shifts: 3, ops: 2 }), 150000); // Press 05: 5 min × 2 operators × 10 changes × 3 shifts
    eq(year('manpower', { ...hr, t: 30, times: 1, shifts: 3, ops: 4 }), 180000); // Tube: 30 min × 4 operators × 3 shifts
    eq(year('material', { basis: 'total', qs: 50, qtyUnit: 'kg', price: 500, scrap: 'pay', srate: 35, freq: 'month' }), 321000); // Tube: 50 kg
    eq(year('material', { mb: 5, ma: 0, qtyUnit: 'kg', pcs: 10, price: 500, oth: 60, freq: 'month' }), 307200); // 3 Tower: 5 kg resin + Rs 60 paper, 10 changeovers
  });

  it('asks only for the inputs of the chosen mode, and keeps older lines', () => {
    expect_deep(missingSavingInputs({ type: 'jobtime', values: { mode: 'hours', hrs: 8, rate: 1000 } } as KaizenSavingLine), []);
    expect_deep(missingSavingInputs({ type: 'jobtime', values: { mode: 'output', rate: 1000 } } as KaizenSavingLine), ['Output before', 'Output after', 'Running hours per day', 'Working days per month']);
    expect_deep(missingSavingInputs({ type: 'manpower', values: { t: 1, ops: 1, wage: 100, wUnit: 'hr', days: 25 } } as KaizenSavingLine), []); // no shift hours with an hourly rate
    eq(year('manpower', { t: 1, tUnit: 'hr', ops: 1, wage: 800, shift: 8, days: 26 }), 31200); // saved before times/shifts: 1 hr a day
  });
});

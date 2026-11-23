import { rupeesSchema, type KaizenSavingLine, type KaizenSavingType } from '@audit5s/contracts';

/**
 * The Kaizen savings calculator (plans/kaizen-module.md), ported unchanged from the owner's
 * Kaizen Sheet Maker (`kaizen-calc.js`), whose formulas were checked against the plants' own
 * Kaizen sheets. Pure: the field app runs it, and its working is stored with the Kaizen so a
 * reviewer sees how the saving was reached.
 *
 * A line is a saving type and the operator's inputs as typed. `calcLine` returns the yearly
 * figure and the working, one step per string. English only, like the source.
 */

// ---------- number formatting (Indian grouping: 1,24,800) ----------
function fmt(n: number, d = 0): string {
  if (!Number.isFinite(n)) return '–';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function rs(n: number, d = 0): string {
  if (d > 0 && Number.isFinite(n) && Math.abs(n - Math.round(n)) < 0.005) d = 0; // Rs 75, not Rs 75.00
  return 'Rs ' + fmt(n, d);
}
/** Trims trailing zeros: 2, 2.5, 0.42. */
function plain(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '–';
  return Number(Number(n).toFixed(d)).toLocaleString('en-IN');
}
function num(v: unknown): number {
  const x = typeof v === 'string' ? (v.trim() === '' ? NaN : parseFloat(v)) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : NaN;
}
function or0(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

export type SavingClass = 'hard' | 'soft' | 'avoid';
export const SAVING_CLASS_LABEL: Record<SavingClass, string> = { hard: 'Hard saving', soft: 'Soft saving', avoid: 'Safety / cost avoidance' };

// ---------- reference figures (calibration knobs: update here when they are revised) ----------
const COST_SHARE = 0.75; // cost price taken as 75% of selling price when the cost is not known
const ICC_DEF = 20; // inventory carrying cost, % of stock value per year
const GRID_CO2 = 0.727; // kg CO2 per kWh, CEA CO2 Baseline Database v20 (FY 2023-24), all-India weighted average
// Employee compensation: Employees' Compensation Act 1923 s.4, carried into the Code on Social Security 2020 s.76
const EC_WAGE_CAP = 15000; // monthly wage ceiling for the calculation (notified Jan 2020)
const EC_MIN_PTD = 140000; // minimum for permanent total disablement
// relevant factor by completed age, 16 (or less) … 65 (or more): Schedule IV / Sixth Schedule
const EC_FACTOR = [228.54, 227.49, 226.38, 225.22, 224.0, 222.71, 221.37, 219.95, 218.47, 216.91, 215.28, 213.57, 211.79, 209.92, 207.98,
  205.95, 203.85, 201.66, 199.4, 197.06, 194.64, 192.14, 189.56, 186.9, 184.17, 181.37, 178.49, 175.54, 172.52, 169.44, 166.29, 163.07,
  159.8, 156.47, 153.09, 149.67, 146.2, 142.68, 139.13, 135.56, 131.95, 128.33, 124.7, 121.05, 117.41, 113.77, 110.14, 106.52, 102.93, 99.37];
// only for safety lines saved with the old 1–5 likelihood scale → times per year
const OLD_PER_YEAR: Record<number, number> = { 1: 0.02, 2: 0.1, 3: 0.33, 4: 1, 5: 2 };
/** Resources for environment savings; co2 in kg per unit (0 = not counted). */
const RES: Record<string, { label: string; co2: number }> = {
  kl: { label: 'kL water', co2: 0 }, diesel: { label: 'litre diesel', co2: 2.68 }, lpg: { label: 'kg LPG', co2: 2.98 },
  png: { label: 'scm PNG / natural gas', co2: 1.9 }, waste: { label: 'kg waste disposed', co2: 0 }, other: { label: 'units', co2: 0 },
};

// ---------- unit pickers shown next to an input; `time: true` converts the value when the unit changes ----------
export const SAVING_SECS: Record<string, number> = { sec: 1, min: 60, hr: 3600 };
export type SavingOption = readonly [value: string, label: string];
export interface SavingUnitPicker { key: string; opts: readonly SavingOption[]; time?: boolean }
const U_TIME: SavingUnitPicker = { key: 'tUnit', opts: [['hr', 'hours'], ['min', 'minutes']], time: true };
const U_JOB: SavingUnitPicker = { key: 'jUnit', opts: [['sec', 'sec'], ['min', 'min'], ['hr', 'hr']], time: true };
const U_CYC: SavingUnitPicker = { key: 'cUnit', opts: [['min', 'min'], ['sec', 'sec'], ['hr', 'hr']], time: true };
const U_QTY: SavingUnitPicker = { key: 'qtyUnit', opts: ['kg', 'litre', 'metre', 'nos', 'sheet', 'set'].map((u) => [u, u] as const) };
const U_AREA: SavingUnitPicker = { key: 'areaUnit', opts: [['sqft', 'sq ft'], ['sqm', 'sq m']] };
const U_LOAD: SavingUnitPicker = { key: 'loadUnit', opts: [['kW', 'kW'], ['W', 'watt']] };
const U_RES: SavingUnitPicker = { key: 'res', opts: Object.keys(RES).map((k) => [k, RES[k]!.label] as const) };
const SQFT_PER_SQM = 10.7639;

/** One input box. `unit: 'text'` is free text; `opts` is a choice; `units` adds a unit picker. */
export interface SavingField {
  id: string;
  label: string;
  sub?: string;
  unit?: string;
  units?: SavingUnitPicker;
  opts?: readonly SavingOption[];
  def: number | string;
  chips?: readonly number[];
  chipSuffix?: string;
  optional?: boolean;
  /** Shown (and required) only while the choice `key` holds one of these values. */
  when?: readonly [key: string, ...values: string[]];
}

// ---------- shared fields ----------
const INV: SavingField = { id: 'inv', label: 'One-time investment', sub: 'optional, for payback', unit: 'Rs', def: 0, optional: true };
const DAYS: SavingField = { id: 'days', label: 'Working days per month', unit: 'days', def: 26, chips: [25, 26, 30], chipSuffix: ' days' };
const SHIFT: SavingField = { id: 'shift', label: 'Shift hours', unit: 'hr', def: 8, chips: [8, 9, 12], chipSuffix: '-hr' };
const OPS: SavingField = { id: 'ops', label: 'Number of operators', unit: 'operators', def: 1 };
const WAGE = (def: number): SavingField => ({ id: 'wage', label: 'Per-day wage', sub: 'per operator', unit: 'Rs/day', def });
const U_WAGE: SavingUnitPicker = { key: 'wUnit', opts: [['day', 'Rs per day'], ['hr', 'Rs per hour']] };
const KIND = (def: 'hard' | 'soft'): SavingField => ({ id: 'kind', label: 'Type of saving', opts: [['hard', 'Hard saving'], ['soft', 'Soft saving']], def });
const LRATE: SavingField = { id: 'lrate', label: 'Labour cost per hour', sub: 'all operators on the job: per-day wage ÷ shift hours (Rs 800 ÷ 8 = Rs 100)', unit: 'Rs/hr', def: 100 };
const MRATE: SavingField = { id: 'mrate', label: 'Machine hour rate', sub: 'power + tooling + maintenance + depreciation per running hour; 0 if no machine', unit: 'Rs/hr', def: 300 };
const PCS: SavingField = { id: 'pcs', label: 'Pieces per month', unit: 'pcs', def: 1000 };
const ICC: SavingField = { id: 'icc', label: 'Inventory carrying cost', sub: 'per year: interest on the money + storage + insurance + obsolescence', unit: '% / yr', def: ICC_DEF, chips: [15, 20, 25], chipSuffix: '%' };

/** Numeric inputs: a missing or blank one reads NaN, as in the source. */
type N = Record<string, number>;
/** Choice and text inputs. */
type S = Record<string, string | undefined>;
/** Read a numeric input; NaN when absent, exactly as the source's `undefined` behaved. */
type V = (key: string) => number;

function kindOf(s: S, def: SavingClass): SavingClass {
  return s.kind === 'hard' || s.kind === 'soft' ? s.kind : def;
}
function hoursPer(s: S, key: string, def: string): number {
  return (SAVING_SECS[s[key] ?? def] ?? 1) / 3600;
}
function persons(n: number, word: string): string {
  return plain(n) + ' ' + word + (n === 1 ? '' : 's');
}

interface CalcResult { day?: number; month?: number; once?: number; cls?: SavingClass; working: string[]; after?: string[]; warn?: string }

export interface SavingType {
  label: string;
  title: string;
  cls: SavingClass;
  pqcdsm: readonly string[];
  note: string;
  fields: readonly SavingField[];
  oneOf?: readonly (readonly [string, string, string])[];
  safety?: true;
  calc?: (g: V, s: S) => CalcResult;
}

// ---------- saving types, grouped: people & time, the wastes, cost & resources, safety ----------
export const SAVING_TYPES: Record<KaizenSavingType, SavingType> = {
  manpower: {
    label: 'Manpower', title: 'Manpower / labour time saved', cls: 'soft',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'Time saved per operator each time the work is done, × times per shift × shifts per day. For a whole day\'s saving, enter it with 1 time and 1 shift. Soft saving unless overtime is cut. If a whole person is freed, use Manpower released; if time is saved per piece or setup, use Time per job.',
    fields: [
      { id: 't', label: 'Time saved per operator, each time', sub: 'per changeover, loading, check…', unit: 'time', units: U_TIME, def: 1 },
      { id: 'times', label: 'Times per shift', unit: 'times', def: 1 },
      { id: 'shifts', label: 'Shifts per day', unit: 'shifts', def: 1, chips: [1, 2, 3], chipSuffix: '' },
      { ...OPS, label: 'Operators', sub: 'per shift' },
      { ...WAGE(800), label: 'Wage', unit: 'Rs', units: U_WAGE },
      { ...SHIFT, when: ['wUnit', 'day'] }, DAYS, INV,
    ],
    calc: (g, s) => {
      const unitMin = s.tUnit === 'min', each = unitMin ? g('t') / 60 : g('t'), hrs = each * g('times') * g('shifts');
      const perHr = s.wUnit === 'hr', rate = perHr ? g('wage') : g('wage') / g('shift'), day = hrs * g('ops') * rate, month = day * g('days');
      const w = perHr ? [] : ['Hourly rate = ' + rs(g('wage')) + ' ÷ ' + plain(g('shift')) + ' hr = ' + rs(rate, 2) + '/hr'];
      if (g('times') !== 1 || g('shifts') !== 1) {
        w.push('Time saved per operator per day = ' + plain(g('t')) + ' ' + (unitMin ? 'min' : 'hr') + ' × ' + plain(g('times')) + ' times × ' + plain(g('shifts')) + ' shifts = ' + plain(hrs, 3) + ' hr');
      }
      w.push('Per day = ' + (unitMin && hrs === each ? plain(g('t')) + ' min (' + plain(hrs, 3) + ' hr)' : plain(hrs, 3) + ' hr') + ' × ' + persons(g('ops'), 'operator') + ' × ' + rs(rate, 2) + '/hr = ' + rs(day, 2),
        'Per month = ' + rs(day, 2) + ' × ' + plain(g('days')) + ' days = ' + rs(month, 2));
      return {
        day, month, working: w,
        warn: !perHr && g('shift') > 0 && each * g('times') > g('shift') ? 'Time saved per operator in a shift is more than the shift length.' : '',
      };
    },
  },
  jobtime: {
    label: 'Time per job', title: 'Time saved per job / setup / check', cls: 'soft',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'For cycle time, setup, loading/unloading, checking or search time cut on each job (fixtures, dies, poka-yoke, one-setup machining). If you know the output instead (45 → 60 sheets a cycle, 3 → 4 cycles a day, 75 → 90 metres an hour), choose Output: the hours freed are the extra output ÷ the old rate. Soft saving: the time is freed, not paid out.',
    fields: [
      { id: 'mode', label: 'Enter as', opts: [['job', 'Time per job'], ['output', 'Output, before → after'], ['hours', 'Hours saved per month']], def: 'job' },
      { id: 'tb', label: 'Time per job, before', unit: 'time', units: U_JOB, def: 30, when: ['mode', 'job'] },
      { id: 'ta', label: 'Time per job, after', unit: 'time', units: U_JOB, def: 15, when: ['mode', 'job'] },
      { id: 'qty', label: 'Jobs per month', sub: 'pieces, setups, checks or searches', unit: 'per month', def: 1000, when: ['mode', 'job'] },
      { id: 'ob', label: 'Output before', sub: 'pieces, metres or cycles in a fixed time: a cycle, an hour, a day', unit: 'per period', def: 45, when: ['mode', 'output'] },
      { id: 'oa', label: 'Output after', sub: 'in the same time', unit: 'per period', def: 60, when: ['mode', 'output'] },
      { id: 'runh', label: 'Running hours per day', sub: 'hours the machine or line runs: 7 one-hour cycles = 7', unit: 'hr/day', def: 8, when: ['mode', 'output'] },
      { ...DAYS, when: ['mode', 'output'] },
      { id: 'hrs', label: 'Hours saved per month', sub: 'machine or labour hours recovered', unit: 'hr/month', def: 8, when: ['mode', 'hours'] },
      { id: 'rate', label: 'Cost per hour', sub: 'per-day wage ÷ shift hours (Rs 800 ÷ 8 = Rs 100); add the machine hour rate if the machine is freed too', unit: 'Rs/hr', def: 100 },
      INV,
    ],
    calc: (g, s) => {
      if (s.mode === 'hours') {
        const month = g('hrs') * g('rate');
        return { month, working: ['Per month = ' + plain(g('hrs'), 2) + ' hr × ' + rs(g('rate'), 2) + '/hr = ' + rs(month, 2)], warn: g('hrs') < 0 ? 'Negative hours show a loss.' : '' };
      }
      if (s.mode === 'output') {
        const up = (g('oa') - g('ob')) / g('ob'), day = g('runh') * up, hrs = day * g('days'), month = hrs * g('rate');
        return {
          month,
          working: ['Output up = (' + plain(g('oa')) + ' − ' + plain(g('ob')) + ') ÷ ' + plain(g('ob')) + ' = ' + plain(up * 100, 1) + '%',
            'Hours freed per day = ' + plain(g('runh')) + ' hr × ' + plain(up * 100, 1) + '% = ' + plain(day, 2) + ' hr (the extra output would have taken this long at the old rate)',
            'Hours freed per month = ' + plain(day, 2) + ' hr × ' + plain(g('days')) + ' days = ' + plain(hrs, 2) + ' hr',
            'Per month = ' + plain(hrs, 2) + ' hr × ' + rs(g('rate'), 2) + '/hr = ' + rs(month, 2)],
          warn: !(g('ob') > 0) ? 'Output before must be more than 0.' : up < 0 ? 'Output went down, so this shows a loss.' : '',
        };
      }
      const u = s.jUnit || 'sec', saved = g('tb') - g('ta'), hrs = (saved * g('qty') * (SAVING_SECS[u] ?? 1)) / 3600, month = hrs * g('rate');
      return {
        month,
        working: ['Time saved per job = ' + plain(g('tb')) + ' − ' + plain(g('ta')) + ' = ' + plain(saved) + ' ' + u,
          'Time saved per month = ' + plain(saved) + ' ' + u + ' × ' + plain(g('qty'), 0) + ' jobs = ' + plain(hrs, 2) + ' hr',
          'Per month = ' + plain(hrs, 2) + ' hr × ' + rs(g('rate'), 2) + '/hr = ' + rs(month, 2)],
        warn: saved < 0 ? 'The time after is more than before, so this shows a loss.' : '',
      };
    },
  },
  headcount: {
    label: 'Manpower released', title: 'Manpower released', cls: 'hard',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'Whole persons no longer needed on this work. Hard saving only if they really leave it (moved to a vacant job, contract ended, overtime stopped).',
    fields: [{ id: 'persons', label: 'Persons released', unit: 'persons', def: 1 }, { id: 'wage', label: 'Per-day wage', sub: 'per person', unit: 'Rs/day', def: 600 }, DAYS, INV],
    calc: (g) => {
      const day = g('persons') * g('wage'), month = day * g('days');
      return {
        day, month,
        working: ['Per day = ' + persons(g('persons'), 'person') + ' × ' + rs(g('wage')) + ' = ' + rs(day, 2),
          'Per month = ' + rs(day, 2) + ' × ' + plain(g('days')) + ' days = ' + rs(month, 2)],
      };
    },
  },
  motion: {
    label: 'Motion', title: 'Motion waste removed (bending, reaching, walking, searching)', cls: 'soft',
    pqcdsm: ['Productivity', 'Morale'],
    note: 'Small movements repeated all day: seconds lost each time × times per day, valued at the hourly wage. Soft saving.',
    fields: [
      { id: 'ms', label: 'Time lost per motion', sub: 'bending to pick up, reaching, turning, walking, searching', unit: 'sec', def: 3 },
      { id: 'mn', label: 'Times per operator per day', unit: 'times', def: 100 },
      OPS, WAGE(600), SHIFT, DAYS, INV,
    ],
    calc: (g) => {
      const sec = g('ms') * g('mn') * g('ops'), hrs = sec / 3600, rate = g('wage') / g('shift'), day = hrs * rate, month = day * g('days');
      return {
        day, month,
        working: ['Time lost per day = ' + plain(g('ms')) + ' sec × ' + plain(g('mn')) + ' times × ' + persons(g('ops'), 'operator') + ' = ' + plain(sec, 0) + ' sec (' + plain(sec / 60, 1) + ' min)',
          'Hourly rate = ' + rs(g('wage')) + ' ÷ ' + plain(g('shift')) + ' hr = ' + rs(rate, 2) + '/hr',
          'Per day = ' + plain(hrs, 3) + ' hr × ' + rs(rate, 2) + ' = ' + rs(day, 2),
          'Per month = ' + rs(day, 2) + ' × ' + plain(g('days')) + ' days = ' + rs(month, 2)],
      };
    },
  },
  waiting: {
    label: 'Waiting', title: 'Waiting time removed', cls: 'soft',
    pqcdsm: ['Productivity', 'Delivery', 'Cost'],
    note: 'Operators (and machines) idle between processes: waiting for material, a crane, inspection, setting. Valued at the hourly wage, plus the machine hour rate if the machine also stood idle. Soft saving.',
    fields: [
      { id: 'wb', label: 'Waiting per operator per day, before', unit: 'time', units: U_TIME, def: 4 },
      { id: 'wa', label: 'Waiting per operator per day, after', unit: 'time', units: U_TIME, def: 0 },
      OPS, WAGE(600), SHIFT, DAYS,
      { id: 'mrate', label: 'Machine hour rate, if the machine also waited', sub: 'optional', unit: 'Rs/hr', def: 0, optional: true },
      INV,
    ],
    calc: (g, s) => {
      const u = s.tUnit === 'min' ? 'min' : 'hr', hrs = (g('wb') - g('wa')) * (u === 'min' ? 1 / 60 : 1), rate = g('wage') / g('shift'), m = or0(g('mrate'));
      const perHr = g('ops') * rate + m, day = hrs * perHr, month = day * g('days');
      return {
        day, month,
        working: ['Waiting cut per day = ' + plain(g('wb')) + ' − ' + plain(g('wa')) + ' = ' + plain(g('wb') - g('wa')) + ' ' + u + (u === 'min' ? ' (' + plain(hrs, 3) + ' hr)' : ''),
          'Cost of waiting per hour = ' + persons(g('ops'), 'operator') + ' × ' + rs(rate, 2) + (m ? ' + machine ' + rs(m) : '') + ' = ' + rs(perHr, 2),
          'Per day = ' + plain(hrs, 3) + ' hr × ' + rs(perHr, 2) + ' = ' + rs(day, 2),
          'Per month = ' + rs(day, 2) + ' × ' + plain(g('days')) + ' days = ' + rs(month, 2)],
        warn: hrs < 0 ? 'Waiting after is more than before, so this shows a loss.' : g('wb') > g('shift') && u === 'hr' ? 'Waiting is more than the shift length.' : '',
      };
    },
  },
  process: {
    label: 'Processing cost', title: 'Processing (conversion) cost per piece reduced', cls: 'soft',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'Cost to process one piece = cycle time × (labour + machine hour rate) + consumables, tooling and power per piece. Saving = (before − after) × pieces. Soft unless the freed hours are actually cut (overtime, shift, outsourcing) or used for paid extra output; if you already know the per-piece cost before and after, use Cost per piece.',
    fields: [
      { id: 'ctb', label: 'Cycle time per piece, before', unit: 'time', units: U_CYC, def: 10 },
      { id: 'cta', label: 'Cycle time per piece, after', unit: 'time', units: U_CYC, def: 8 },
      LRATE, MRATE,
      { id: 'cnb', label: 'Consumables, tooling, power per piece, before', sub: 'optional', unit: 'Rs/pc', def: 0, optional: true },
      { id: 'cna', label: 'Consumables, tooling, power per piece, after', sub: 'optional', unit: 'Rs/pc', def: 0, optional: true },
      PCS, KIND('soft'), INV,
    ],
    calc: (g, s) => {
      const h = hoursPer(s, 'cUnit', 'min'), u = s.cUnit || 'min', perHr = g('lrate') + g('mrate');
      const pb = g('ctb') * h * perHr + or0(g('cnb')), pa = g('cta') * h * perHr + or0(g('cna')), per = pb - pa, month = per * g('pcs');
      const line = (ct: number, cn: number, p: number) => plain(ct) + ' ' + u + ' × ' + rs(perHr, 2) + '/hr' + (or0(cn) ? ' + ' + rs(cn, 2) : '') + ' = ' + rs(p, 2);
      return {
        month, cls: kindOf(s, 'soft'),
        working: ['Labour + machine per hour = ' + rs(g('lrate'), 2) + ' + ' + rs(g('mrate'), 2) + ' = ' + rs(perHr, 2),
          'Processing cost per piece, before = ' + line(g('ctb'), g('cnb'), pb),
          'Processing cost per piece, after = ' + line(g('cta'), g('cna'), pa),
          'Per month = ' + rs(per, 2) + ' saved per piece × ' + plain(g('pcs'), 0) + ' pcs = ' + rs(month, 2)],
        warn: per < 0 ? 'Processing cost went up, so this shows a loss.' : '',
      };
    },
  },
  overproc: {
    label: 'Overprocessing', title: 'Overprocessing removed (extra operations, cuts, finishing)', cls: 'hard',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'Work the customer does not need: extra CNC cuts, double inspection, over-finishing. Saving per piece = machine + labour time of the extra work + material that went to scrap + tooling used. Choose Soft if only time is freed.',
    fields: [
      { id: 'xt', label: 'Extra machining / work time removed per piece', unit: 'time', units: U_CYC, def: 2 },
      MRATE, LRATE,
      { id: 'xm', label: 'Extra material scrapped per piece', sub: 'optional: chips, trimmings', unit: 'qty', units: U_QTY, def: 0, optional: true },
      { id: 'xmr', label: 'Material rate per unit', sub: 'optional', unit: 'Rs', def: 0, optional: true },
      { id: 'xc', label: 'Tooling / consumables per piece', sub: 'optional: insert wear, grinding wheel, paint', unit: 'Rs/pc', def: 0, optional: true },
      PCS, KIND('hard'), INV,
    ],
    calc: (g, s) => {
      const h = hoursPer(s, 'cUnit', 'min'), u = s.cUnit || 'min', time = g('xt') * h * (g('mrate') + g('lrate')), mat = or0(g('xm')) * or0(g('xmr')), tool = or0(g('xc'));
      const per = time + mat + tool, month = per * g('pcs'), w: string[] = [];
      w.push('Machine + labour = ' + plain(g('xt')) + ' ' + u + ' × (' + rs(g('mrate')) + ' + ' + rs(g('lrate')) + ')/hr = ' + rs(time, 2) + ' per piece');
      if (mat) w.push('Material = ' + plain(g('xm')) + ' ' + (s.qtyUnit || 'kg') + ' × ' + rs(g('xmr'), 2) + ' = ' + rs(mat, 2) + ' per piece');
      if (tool) w.push('Tooling / consumables = ' + rs(tool, 2) + ' per piece');
      w.push('Per month = ' + rs(per, 2) + ' per piece × ' + plain(g('pcs'), 0) + ' pcs = ' + rs(month, 2));
      return { month, cls: kindOf(s, 'hard'), working: w };
    },
  },
  overprod: {
    label: 'Overproduction', title: 'Overproduction stopped (labour + machine + inventory carrying cost)', cls: 'hard',
    pqcdsm: ['Productivity', 'Cost', 'Delivery'],
    note: 'Making more than the customer needs, or earlier. Saving = labour and machine hours no longer spent on the excess pieces + carrying cost of the excess stock no longer held.',
    fields: [
      { id: 'pcs', label: 'Excess pieces no longer made, per month', unit: 'pcs', def: 200 },
      { id: 'tpp', label: 'Time to make one piece', unit: 'time', units: U_CYC, def: 5 },
      LRATE, MRATE,
      { id: 'stock', label: 'Excess stock no longer held', sub: 'average value of the extra pieces that used to sit in stock', unit: 'Rs', def: 100000 },
      ICC, KIND('hard'), INV,
    ],
    calc: (g, s) => {
      const h = hoursPer(s, 'cUnit', 'min'), hrs = g('pcs') * g('tpp') * h, work = hrs * (g('lrate') + g('mrate')), hold = (g('stock') * g('icc')) / 100 / 12, month = work + hold;
      return {
        month, cls: kindOf(s, 'hard'),
        working: ['Hours no longer spent = ' + plain(g('pcs'), 0) + ' pcs × ' + plain(g('tpp')) + ' ' + (s.cUnit || 'min') + ' = ' + plain(hrs, 2) + ' hr per month',
          'Labour + machine = ' + plain(hrs, 2) + ' hr × (' + rs(g('lrate')) + ' + ' + rs(g('mrate')) + ')/hr = ' + rs(work, 2) + ' per month',
          'Carrying cost = ' + rs(g('stock')) + ' × ' + plain(g('icc')) + '% ÷ 12 = ' + rs(hold, 2) + ' per month',
          'Per month = ' + rs(work, 2) + ' + ' + rs(hold, 2) + ' = ' + rs(month, 2)],
      };
    },
  },
  inventory: {
    label: 'Inventory', title: 'Inventory reduced (carrying cost)', cls: 'hard',
    pqcdsm: ['Cost', 'Delivery'],
    note: 'Stock costs money to hold, like interest on a loan: interest on the money tied up, storage space, handling, insurance, damage and obsolescence. Saving per year = inventory cut × carrying cost %. The cash freed is shown but not counted as a saving.',
    fields: [
      { id: 'vb', label: 'Average inventory value, before', sub: 'raw material, WIP or finished goods', unit: 'Rs', def: 1000000 },
      { id: 'va', label: 'Average inventory value, after', unit: 'Rs', def: 500000 },
      ICC, KIND('hard'), INV,
    ],
    calc: (g, s) => {
      const cut = g('vb') - g('va'), year = (cut * g('icc')) / 100;
      return {
        month: year / 12, cls: kindOf(s, 'hard'),
        working: ['Inventory cut = ' + rs(g('vb')) + ' − ' + rs(g('va')) + ' = ' + rs(cut),
          'Carrying cost saved per year = ' + rs(cut) + ' × ' + plain(g('icc')) + '% = ' + rs(year) + '; per month = ÷ 12 = ' + rs(year / 12, 2)],
        after: cut > 0 ? ['Cash freed once = ' + rs(cut) + ' (working capital released, not counted in the saving)'] : [],
        warn: cut < 0 ? 'Inventory went up, so this shows a cost.' : '',
      };
    },
  },
  rejection: {
    label: 'Rejection / rework', title: 'Defects: rejection / rework / scrap reduction', cls: 'hard',
    pqcdsm: ['Quality', 'Cost'],
    note: 'A rejected piece loses what it cost to make (its cost price), not its selling price. If the cost price is not known, ' + COST_SHARE * 100 + '% of the selling price is used. For rework, enter the rework cost per job as the cost price.',
    oneOf: [['cost', 'sp', 'Cost price or selling price per job']],
    fields: [
      { id: 'before', label: 'Rejected or reworked jobs per month, before', unit: 'jobs', def: 10 },
      { id: 'after', label: 'Rejected or reworked jobs per month, after', unit: 'jobs', def: 0 },
      { id: 'cost', label: 'Cost price per job', sub: 'material + labour + overhead − scrap value; or the rework cost', unit: 'Rs/job', def: 1000, optional: true },
      { id: 'sp', label: 'Selling price per job', sub: 'only if the cost price is not known: ' + COST_SHARE * 100 + '% of it is used', unit: 'Rs/job', def: '', optional: true },
      INV,
    ],
    calc: (g) => {
      const fromSp = !Number.isFinite(g('cost')), loss = fromSp ? g('sp') * COST_SHARE : g('cost'), avoided = g('before') - g('after'), month = avoided * loss, w: string[] = [];
      if (fromSp) w.push('Loss per job = ' + COST_SHARE * 100 + '% of selling price ' + rs(g('sp')) + ' = ' + rs(loss, 2) + ' (cost price not known)');
      w.push('Rejections avoided = ' + plain(g('before'), 0) + ' − ' + plain(g('after'), 0) + ' = ' + plain(avoided, 0) + ' jobs/month');
      w.push('Per month = ' + plain(avoided, 0) + ' jobs × ' + rs(loss, 2) + ' = ' + rs(month, 2));
      return { month, working: w, warn: avoided < 0 ? 'Rejections went up after the change, so this shows a loss.' : '' };
    },
  },
  otd: {
    label: 'Delivery (OTD)', title: 'Faster delivery: lead time per consignment cut', cls: 'soft',
    pqcdsm: ['Delivery', 'Productivity'],
    note: 'Shorter lead time lets the same set-up send more consignments in a year. Saving = extra consignments × profit per consignment. Count it as Hard only if the extra orders are really there and booked; otherwise it is potential (Soft). Less WIP from the shorter lead time can be added with Inventory.',
    fields: [
      { id: 'ltb', label: 'Lead time per consignment, before', unit: 'days', def: 10 },
      { id: 'lta', label: 'Lead time per consignment, after', unit: 'days', def: 6 },
      { id: 'dy', label: 'Working days per year', unit: 'days', def: 300, chips: [300, 312, 365], chipSuffix: ' days' },
      { id: 'profit', label: 'Profit per consignment', sub: 'selling price − all costs of one consignment', unit: 'Rs', def: 10000 },
      KIND('soft'), INV,
    ],
    calc: (g, s) => {
      const nb = g('dy') / g('ltb'), na = g('dy') / g('lta'), extra = na - nb, year = extra * g('profit');
      return {
        month: year / 12, cls: kindOf(s, 'soft'),
        working: ['Consignments per year, before = ' + plain(g('dy')) + ' ÷ ' + plain(g('ltb')) + ' days = ' + plain(nb, 1),
          'Consignments per year, after = ' + plain(g('dy')) + ' ÷ ' + plain(g('lta')) + ' days = ' + plain(na, 1),
          'Extra profit per year = ' + plain(extra, 1) + ' consignments × ' + rs(g('profit')) + ' = ' + rs(year) + '; per month = ÷ 12 = ' + rs(year / 12, 2)],
        warn: !(g('ltb') > 0 && g('lta') > 0) ? 'Lead times must be more than 0.' : extra < 0 ? 'Lead time went up, so this shows a loss.' : '',
      };
    },
  },
  material: {
    label: 'Material', title: 'Material / consumable saving', cls: 'hard',
    pqcdsm: ['Cost'],
    note: 'Less material used for each piece. Saving = (consumption per piece before − after) × pieces × effective rate. 500 g = 0.5 kg. If the material saved would have become scrap: add the disposal charge when you pay to get rid of the scrap, or take off the scrap value when you sell it. Choose One time only for a single lot.',
    fields: [
      { id: 'basis', label: 'Enter as', opts: [['piece', 'Per piece'], ['total', 'Total saved']], def: 'piece' },
      { id: 'mb', label: 'Consumption per piece, before', unit: 'qty', units: U_QTY, def: 1, when: ['basis', 'piece'] },
      { id: 'ma', label: 'Consumption per piece, after', unit: 'qty', units: U_QTY, def: 0.5, when: ['basis', 'piece'] },
      { id: 'pcs', label: 'Pieces', sub: 'pieces, batches or changeovers: per month, or in the lot if one time', unit: 'pcs', def: 100, when: ['basis', 'piece'] },
      { id: 'qs', label: 'Quantity saved', sub: 'per month, or in the lot if one time', unit: 'qty', units: U_QTY, def: 50, when: ['basis', 'total'] },
      { id: 'price', label: 'Rate per unit', sub: 'Rs per kg, litre, metre…', unit: 'Rs', def: 100 },
      { id: 'oth', label: 'Other consumables saved, in Rs', sub: 'optional: paper, tape, packing… per piece, or in total', unit: 'Rs', def: 0, optional: true },
      { id: 'scrap', label: 'Scrap', opts: [['none', 'No scrap'], ['pay', 'We pay to dispose of it'], ['sell', 'We sell it']], def: 'none' },
      { id: 'srate', label: 'Scrap rate per unit', sub: 'disposal charge or scrap selling price, Rs per kg, litre…', unit: 'Rs', def: 0, optional: true },
      { id: 'freq', label: 'Saving is', opts: [['month', 'Recurring, every month'], ['once', 'One time only']], def: 'month' },
      INV,
    ],
    calc: (g, s) => {
      const u = s.qtyUnit || 'kg', once = s.freq === 'once', byTotal = s.basis === 'total', per = g('mb') - g('ma');
      const qty = byTotal ? g('qs') : per * g('pcs'), oth = or0(g('oth')), othSum = byTotal ? oth : oth * g('pcs');
      const sr = or0(g('srate')), scrap = s.scrap === 'pay' ? sr : s.scrap === 'sell' ? -sr : 0, rate = g('price') + scrap, mat = qty * rate, total = mat + othSum;
      const where = once ? 'in this lot' : 'per month';
      const w = byTotal ? ['Saved ' + where + ' = ' + plain(qty, 2) + ' ' + u + ' (entered)'] : ['Saved per piece = ' + plain(g('mb'), 4) + ' − ' + plain(g('ma'), 4) + ' = ' + plain(per, 4) + ' ' + u,
        'Saved ' + where + ' = ' + plain(per, 4) + ' ' + u + ' × ' + plain(g('pcs'), 0) + ' pcs = ' + plain(qty, 2) + ' ' + u];
      if (scrap > 0) w.push('Effective rate = ' + rs(g('price'), 2) + ' material + ' + rs(sr, 2) + ' scrap disposal saved = ' + rs(rate, 2) + ' per ' + u);
      if (scrap < 0) w.push('Effective rate = ' + rs(g('price'), 2) + ' material − ' + rs(sr, 2) + ' scrap sale lost = ' + rs(rate, 2) + ' per ' + u);
      const head = once ? 'This lot' : 'Per month';
      if (oth) {
        w.push('Material ' + where + ' = ' + plain(qty, 2) + ' ' + u + ' × ' + rs(rate, 2) + ' = ' + rs(mat, 2),
          'Other consumables ' + where + ' = ' + (byTotal ? rs(oth, 2) + ' (entered)' : rs(oth, 2) + ' × ' + plain(g('pcs'), 0) + ' pcs = ' + rs(othSum, 2)),
          head + ' = ' + rs(mat, 2) + ' + ' + rs(othSum, 2) + ' = ' + rs(total, 2) + (once ? ' (not repeated, not multiplied by 12)' : ''));
      } else {
        w.push(head + ' = ' + plain(qty, 2) + ' ' + u + ' × ' + rs(rate, 2) + ' = ' + rs(total, 2) + (once ? ' (not repeated, not multiplied by 12)' : ''));
      }
      const warn = !byTotal && per < 0 ? 'Consumption after is more than before, so this shows a loss.' : '';
      return once ? { once: total, working: w, warn } : { month: total, working: w, warn };
    },
  },
  unitcost: {
    label: 'Cost per piece', title: 'Lower cost per piece (rate, supplier, tooling, job work, freight)', cls: 'hard',
    pqcdsm: ['Cost'],
    note: 'Hard saving: the same item now costs less (cheaper supplier or material, in-house tool, design change, lower job-work rate or freight). Use one line per part or cost head.',
    fields: [
      { id: 'desc', label: 'What costs less', unit: 'text', def: '' },
      { id: 'cb', label: 'Cost per unit, before', unit: 'Rs', def: 100 },
      { id: 'ca', label: 'Cost per unit, after', unit: 'Rs', def: 90 },
      { id: 'qty', label: 'Quantity', sub: 'pieces, kg, trips… in the period below', unit: 'nos', def: 100 },
      { id: 'freq', label: 'Quantity is', opts: [['month', 'Per month'], ['year', 'Per year'], ['once', 'One time only (this lot)']], def: 'month' },
      INV,
    ],
    calc: (g, s) => {
      const per = g('cb') - g('ca'), total = per * g('qty'), d = s.desc ? s.desc + ': ' : '';
      const w = [d + 'Saving per unit = ' + rs(g('cb'), 2) + ' − ' + rs(g('ca'), 2) + ' = ' + rs(per, 2)];
      const warn = per < 0 ? 'The cost after is more than before, so this shows a loss.' : '';
      if (s.freq === 'once') { w.push('This lot = ' + rs(per, 2) + ' × ' + plain(g('qty')) + ' = ' + rs(total) + ' (not repeated, not multiplied by 12)'); return { once: total, working: w, warn }; }
      if (s.freq === 'year') { w.push('Per year = ' + rs(per, 2) + ' × ' + plain(g('qty')) + ' = ' + rs(total, 2) + '; per month = ÷ 12 = ' + rs(total / 12, 2)); return { month: total / 12, working: w, warn }; }
      w.push('Per month = ' + rs(per, 2) + ' × ' + plain(g('qty')) + ' = ' + rs(total, 2));
      return { month: total, working: w, warn };
    },
  },
  electricity: {
    label: 'Electricity', title: 'Electricity saving', cls: 'hard',
    pqcdsm: ['Cost'],
    note: 'Units (kWh) = load × running hours; 1 unit = 1,000 watts for 1 hour. Covers a smaller load (LED, VFD), fewer running hours (switching off, daylight, idle running) or both. Take the rate per unit from the latest bill.',
    fields: [
      { id: 'lb', label: 'Load before', sub: 'kW or watts', unit: 'load', units: U_LOAD, def: 1 },
      { id: 'la', label: 'Load after', sub: 'same as before if only the hours changed', unit: 'load', units: U_LOAD, def: 0.5 },
      { id: 'hb', label: 'Running hours per day, before', unit: 'hr', def: 8 },
      { id: 'ha', label: 'Running hours per day, after', unit: 'hr', def: 8 },
      DAYS,
      { id: 'tariff', label: 'Rate per unit (kWh)', sub: 'from your power bill, Rs 8–11 for most industrial connections', unit: 'Rs/kWh', def: 9 },
      INV,
    ],
    calc: (g, s) => {
      const watts = s.loadUnit === 'W', k = watts ? 1 / 1000 : 1, u = watts ? ' W' : ' kW';
      const eb = g('lb') * k * g('hb'), ea = g('la') * k * g('ha'), units = eb - ea, day = units * g('tariff'), month = day * g('days'), co2 = (units * g('days') * 12 * GRID_CO2) / 1000;
      return {
        day, month,
        working: ['Units per day, before = ' + plain(g('lb')) + u + ' × ' + plain(g('hb')) + ' hr = ' + plain(eb, 3) + ' kWh',
          'Units per day, after = ' + plain(g('la')) + u + ' × ' + plain(g('ha')) + ' hr = ' + plain(ea, 3) + ' kWh',
          'Per day = ' + plain(units, 3) + ' kWh saved × ' + rs(g('tariff'), 2) + ' = ' + rs(day, 2),
          'Per month = ' + rs(day, 2) + ' × ' + plain(g('days')) + ' days = ' + rs(month, 2)],
        after: co2 > 0 ? ['CO2 avoided = ' + plain(units * g('days') * 12, 0) + ' kWh/year × ' + GRID_CO2 + ' kg = ' + plain(co2, 2) + ' tonnes per year'] : [],
        warn: units < 0 ? 'More units are used after the change, so this shows a loss.' : '',
      };
    },
  },
  environment: {
    label: 'Environment', title: 'Environment: water, fuel, gas or waste disposal saved', cls: 'hard',
    pqcdsm: ['Cost', 'Morale'],
    note: 'Resources an MSME pays for every month: water (bill or tanker), diesel for the DG set or forklift, LPG / PNG for furnaces and ovens, and fees paid to dispose of waste (oil, sludge, chemicals). CO2 is shown for fuels. For electricity use Electricity; for scrap that comes from material saved use Material.',
    fields: [
      { id: 'rb', label: 'Used per month, before', unit: 'res', units: U_RES, def: 100 },
      { id: 'ra', label: 'Used per month, after', unit: 'res', units: U_RES, def: 80 },
      { id: 'rate', label: 'Rate per unit', sub: 'water Rs/kL, diesel Rs/litre, LPG Rs/kg, PNG Rs/scm, disposal Rs/kg', unit: 'Rs', def: 90 },
      KIND('hard'), INV,
    ],
    calc: (g, s) => {
      const r = RES[s.res ?? ''] ?? RES.other!, saved = g('rb') - g('ra'), month = saved * g('rate'), co2 = (saved * 12 * r.co2) / 1000;
      return {
        month, cls: kindOf(s, 'hard'),
        working: ['Saved per month = ' + plain(g('rb')) + ' − ' + plain(g('ra')) + ' = ' + plain(saved) + ' ' + r.label,
          'Per month = ' + plain(saved) + ' × ' + rs(g('rate'), 2) + ' = ' + rs(month, 2)],
        after: co2 > 0 ? ['CO2 avoided = ' + plain(saved * 12) + ' ' + r.label + '/year × ' + r.co2 + ' kg = ' + plain(co2, 2) + ' tonnes per year'] : [],
        warn: saved < 0 ? 'More is used after the change, so this shows a loss.' : '',
      };
    },
  },
  space: {
    label: 'Space', title: 'Floor space saved', cls: 'soft',
    pqcdsm: ['Productivity', 'Cost'],
    note: 'Valued at rent per sq ft. Soft saving unless rent actually goes down or the freed space avoids renting or building more (then choose Hard).',
    fields: [
      { id: 'area', label: 'Floor space freed', unit: 'area', units: U_AREA, def: 100 },
      { id: 'rent', label: 'Rent per sq ft per month', sub: 'plant rent, or market rent nearby', unit: 'Rs/sq ft', def: 25 },
      KIND('soft'), INV,
    ],
    calc: (g, s) => {
      const sqm = s.areaUnit === 'sqm', sqft = sqm ? g('area') * SQFT_PER_SQM : g('area'), month = sqft * g('rent'), w: string[] = [];
      if (sqm) w.push('Area = ' + plain(g('area')) + ' sq m × ' + SQFT_PER_SQM + ' = ' + plain(sqft, 1) + ' sq ft');
      w.push('Per month = ' + plain(sqft, 1) + ' sq ft × ' + rs(g('rent'), 2) + ' = ' + rs(month, 2));
      return { month, cls: kindOf(s, 'soft'), working: w };
    },
  },
  safety: {
    label: 'Safety', title: 'Safety: accidents prevented', cls: 'avoid', safety: true,
    pqcdsm: ['Safety', 'Morale'],
    note: "How bad the accident would be, and how many times a year it could happen before and after the Kaizen. To put a rupee value on it, fill the operator details: cost of one such accident (compensation under the Employees' Compensation Act / Social Security Code, medical, wages for days off, plus indirect costs) × accidents fewer per year. Shown as cost avoided, separate from the yearly saving.",
    fields: [
      { id: 'sev', label: 'How bad would it be?', sub: '1 first aid · 2 medical treatment · 3 lost-time injury · 4 permanent partial (finger, hand) · 5 death / permanent total', unit: '1–5', def: 3 },
      { id: 'nb', label: 'Times it could happen in a year, before', sub: 'less than 1 is fine: 0.5 = once in 2 years, 0.2 = once in 5 years', unit: 'per year', def: 1 },
      { id: 'na', label: 'Times it could happen in a year, after', sub: '0 if the Kaizen removes it completely', unit: 'per year', def: 0 },
      { id: 'wage', label: "Operator's monthly wage", sub: 'optional: fill to get the rupee value', unit: 'Rs/month', def: '', optional: true },
      { id: 'age', label: "Operator's age", sub: 'compensation depends on age', unit: 'years', def: 30, optional: true },
      { id: 'loss', label: 'Loss of earning capacity', sub: 'severity 4 only, Schedule I: finger 20–30%, thumb 30%, hand 60%, arm 70–90%', unit: '%', def: '', optional: true, chips: [20, 30, 60, 90], chipSuffix: '%' },
      { id: 'off', label: 'Days off work', sub: 'optional', unit: 'days', def: '', optional: true },
      { id: 'med', label: 'Medical / hospital cost', sub: 'optional', unit: 'Rs', def: '', optional: true },
      { id: 'esi', label: 'Operator covered by ESI?', opts: [['no', 'No: the employer pays compensation'], ['yes', 'Yes: ESIC pays compensation']], def: 'no' },
      { id: 'ind', label: 'Indirect cost', sub: 'lost production, investigation, replacement and training, repairs, legal: 1 = as much again as the direct cost', unit: '× direct', def: 1, optional: true, chips: [1, 2, 4], chipSuffix: '×' },
      { id: 'inv', label: 'Cost of the fix', sub: 'optional', unit: 'Rs', def: 0, optional: true },
    ],
  },
  other: {
    label: 'Other', title: 'Other saving or one-time gain', cls: 'hard',
    pqcdsm: ['Cost'],
    note: 'For savings that do not fit the other types, or one-time gains such as scrap sold or a licence/purchase avoided. Describe how the figure was worked out.',
    fields: [
      { id: 'desc', label: 'What is saved and how', unit: 'text', def: '' },
      { id: 'freq', label: 'How often', opts: [['month', 'Every month'], ['once', 'One time only']], def: 'month' },
      { id: 'monthly', label: 'Amount', sub: 'per month, or the one-time total', unit: 'Rs', def: 0 },
      KIND('hard'), INV,
    ],
    calc: (g, s) => {
      const cls = kindOf(s, 'hard'), d = s.desc ? s.desc + ': ' : '';
      if (s.freq === 'once') return { once: g('monthly'), cls, working: [d + 'One-time benefit = ' + rs(g('monthly')) + ' (not repeated, not multiplied by 12)'] };
      return { month: g('monthly'), cls, working: [d + 'Per month = ' + rs(g('monthly'), 2) + ' (entered)'] };
    },
  },
};

const SEVERITY: Record<number, string> = { 1: 'first aid', 2: 'medical treatment', 3: 'lost-time injury', 4: 'permanent partial disablement', 5: 'death / permanent total disablement' };
function clamp15(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}
function ecFactor(age: number): number {
  return EC_FACTOR[Math.min(EC_FACTOR.length - 1, Math.max(0, Math.floor(Number.isFinite(age) ? age : 30) - 16))]!;
}

/** Bring lines saved by older versions of the calculator up to the current fields (keeps their numbers). */
function upgrade(line: KaizenSavingLine): KaizenSavingLine {
  const v = { ...line.values };
  if (line.type === 'electricity' && v.lb === undefined && v.kw !== undefined) Object.assign(v, { lb: v.kw, la: 0, hb: v.hrs, ha: v.hrs, loadUnit: 'kW' });
  if (line.type === 'material' && v.mb === undefined && v.qty !== undefined) Object.assign(v, { mb: v.qty, ma: 0, pcs: v.days, freq: 'month' }); // old: quantity saved per day × days
  if (line.type === 'safety' && v.nb === undefined && v.lb !== undefined) Object.assign(v, { nb: OLD_PER_YEAR[Math.round(num(v.lb))] ?? 0, na: OLD_PER_YEAR[Math.round(num(v.la))] ?? 0 }); // old 1–5 likelihood
  if (line.type === 'manpower' && v.times === undefined) Object.assign(v, { times: 1, shifts: 1 }); // old: time saved per operator per day
  return { type: line.type, values: v };
}

/** Whether a field is shown for the line's current choices (a missing choice reads as its default). */
export function savingFieldShown(line: KaizenSavingLine, f: SavingField): boolean {
  if (!f.when) return true;
  const [key, ...vals] = f.when, T = SAVING_TYPES[line.type];
  const own = T.fields.find((x) => x.id === key)?.def ?? T.fields.find((x) => x.units?.key === key)?.units?.opts[0]?.[0];
  return vals.includes(String(line.values[key] ?? own));
}
function isText(T: SavingType, k: string): boolean {
  if (/Unit$/.test(k) || k === 'res') return true;
  const f = T.fields.find((field) => field.id === k);
  return !!f && !!(f.opts || f.unit === 'text');
}

/** Defaults for a new line of the given type. */
export function newSavingLine(type: KaizenSavingType): KaizenSavingLine {
  const values: Record<string, string | number> = {};
  for (const f of SAVING_TYPES[type].fields) {
    values[f.id] = f.def;
    if (f.units) values[f.units.key] = f.units.opts[0]![0];
  }
  return { type, values };
}

/** Labels of the required inputs that are missing or not a number. */
export function missingSavingInputs(line: KaizenSavingLine): string[] {
  const T = SAVING_TYPES[line.type], up = upgrade(line), v = up.values;
  const out = T.fields.filter((f) => !f.optional && !f.opts && f.unit !== 'text' && savingFieldShown(up, f) && !Number.isFinite(num(v[f.id]))).map((f) => f.label);
  for (const [a, b, label] of T.oneOf ?? []) if (!Number.isFinite(num(v[a])) && !Number.isFinite(num(v[b]))) out.push(label);
  return out;
}

export interface SavingResult {
  type: KaizenSavingType;
  label: string;
  cls: SavingClass;
  day?: number;
  month: number;
  year: number;
  /** A one-time gain: counted once, never × 12. */
  once?: number;
  /** Safety: cost avoided per year, risk-based. */
  avoided?: number;
  cost?: number;
  inv: number;
  payback?: number;
  roi?: number;
  headline: string;
  working: string[];
  warn: string;
  times?: { sev: number; before: number; after: number; drop: number };
}

function calcSafety(T: SavingType, g: V, s: S, inv: number): SavingResult {
  const sev = clamp15(g('sev')), drop = g('nb') - g('na');
  const work = ['Could happen ' + plain(g('nb')) + ' times a year before, ' + plain(g('na')) + ' after: ' + plain(drop) + ' fewer per year (' + SEVERITY[sev] + ')'];
  const out: SavingResult = {
    type: 'safety', label: T.label, cls: 'avoid', year: 0, month: 0, inv, avoided: 0, headline: '', working: work,
    warn: drop < 0 ? 'It could happen more often after the change.' : '',
    times: { sev, before: g('nb'), after: g('na'), drop },
  };
  const wage = g('wage');
  if (Number.isFinite(wage) && wage > 0) {
    const capW = Math.min(wage, EC_WAGE_CAP), F = ecFactor(g('age')), full = Math.max(0.6 * capW * F, EC_MIN_PTD);
    let comp = 0;
    if (sev === 5) comp = full;
    if (sev === 4) {
      comp = (full * or0(g('loss'))) / 100;
      if (!or0(g('loss'))) out.warn = 'Enter the loss of earning capacity % for a permanent partial injury.';
    }
    if (sev >= 4) work.push('Full compensation = max(60% × ' + rs(capW) + (wage > EC_WAGE_CAP ? ' (wage capped)' : '') + ' × age factor ' + F + ', ' + rs(EC_MIN_PTD) + ') = ' + rs(full) +
      (sev === 4 ? '; × ' + plain(or0(g('loss'))) + '% = ' + rs(comp) : ''));
    if (comp && s.esi === 'yes') { work.push('Covered by ESI: ESIC pays the compensation, so it is left out'); comp = 0; }
    const lost = (or0(g('off')) * wage) / 26, med = or0(g('med')), direct = comp + med + lost, ind = or0(g('ind')), cost = direct * (1 + ind);
    work.push('Direct cost = compensation ' + rs(comp) + ' + medical ' + rs(med) + ' + wages for ' + plain(or0(g('off'))) + ' days off ' + rs(lost) + ' = ' + rs(direct));
    work.push('Cost of one such accident = ' + rs(direct) + ' × (1 + ' + plain(ind) + ' indirect) = ' + rs(cost));
    out.avoided = drop * cost;
    out.cost = cost;
    work.push('Cost avoided per year = ' + plain(drop) + ' fewer accidents × ' + rs(cost) + ' = ' + rs(out.avoided));
  }
  if (inv > 0) work.push('Cost of the fix = ' + rs(inv) + (out.avoided! > 0 ? '; pays back in ' + fmt(inv / (out.avoided! / 12), 1) + ' months of cost avoided' : ''));
  out.headline = 'Accidents per year ' + plain(g('nb')) + ' → ' + plain(g('na')) + (out.avoided ? '; ' + rs(out.avoided) + ' per year avoided' : '');
  return out;
}

/** Calculate one saving line. Null when a required input is missing. */
export function calcSavingLine(line: KaizenSavingLine): SavingResult | null {
  const T = SAVING_TYPES[line.type];
  if (!T || missingSavingInputs(line).length) return null;
  const values = upgrade(line).values;
  const n: N = {}, s: S = {};
  for (const [k, x] of Object.entries(values)) {
    if (isText(T, k)) s[k] = String(x);
    else n[k] = num(x);
  }
  const g: V = (key) => n[key] ?? NaN;
  const inv = Number.isFinite(g('inv')) ? g('inv') : 0;

  if (T.safety || !T.calc) return calcSafety(T, g, s, inv);

  const r = T.calc(g, s);
  const cls = r.cls ?? T.cls, extra = r.after ?? [];
  if (r.once !== undefined) {
    return { type: line.type, label: T.label, cls, once: r.once, month: 0, year: 0, inv, payback: NaN, roi: NaN,
      headline: rs(r.once) + ' one-time', working: [...r.working, ...(inv > 0 ? ['Investment = ' + rs(inv)] : []), ...extra], warn: r.warn ?? '' };
  }
  const month = r.month ?? NaN, year = month * 12;
  const working = [...r.working, 'Per year = ' + rs(month, 2) + ' × 12 = ' + rs(year)];
  const payback = inv > 0 && month > 0 ? inv / month : NaN;
  const roi = inv > 0 ? ((year - inv) / inv) * 100 : NaN;
  if (inv > 0) {
    working.push('Investment = ' + rs(inv) + (Number.isFinite(payback)
      ? '; payback = ' + rs(inv) + ' ÷ ' + rs(month) + ' per month = ' + fmt(payback, 1) + ' months'
      : '; no payback (saving is zero or negative)'));
    working.push('First-year net saving = ' + rs(year) + ' − ' + rs(inv) + ' = ' + rs(year - inv));
  }
  return { type: line.type, label: T.label, cls, ...(r.day !== undefined ? { day: r.day } : {}), month, year, inv, payback, roi,
    headline: rs(year) + ' per year', working: [...working, ...extra], warn: r.warn ?? '' };
}

export interface SavingTotals { hard: number; soft: number; inv: number; total: number; payback: number; count: number; safety: number; oneTime: number; avoided: number }

/** Totals across all lines of one Kaizen. `total` (hard + soft, per year) is the sheet's annual saving. */
export function savingTotals(results: readonly (SavingResult | null)[]): SavingTotals {
  const t: SavingTotals = { hard: 0, soft: 0, inv: 0, total: 0, payback: NaN, count: results.length, safety: 0, oneTime: 0, avoided: 0 };
  for (const r of results) {
    if (!r) continue;
    if (r.once !== undefined) t.oneTime += r.once;
    if (r.cls === 'hard') t.hard += r.year;
    if (r.cls === 'soft') t.soft += r.year;
    if (r.cls === 'avoid') { t.safety += 1; t.avoided += r.avoided ?? 0; }
    t.inv += r.inv || 0;
  }
  t.total = t.hard + t.soft;
  if (t.inv > 0 && t.total > 0) t.payback = t.inv / (t.total / 12);
  return t;
}

/** The working as plain text, as printed in the Benefits block of the Kaizen sheet. */
export function savingsText(results: readonly (SavingResult | null)[]): string {
  const rows = results.filter((r): r is SavingResult => r !== null);
  if (!rows.length) return '';
  const out: string[] = [];
  rows.forEach((r, i) => {
    out.push('Saving ' + (i + 1) + ' – ' + SAVING_TYPES[r.type].title + ' (' + SAVING_CLASS_LABEL[r.cls] + ')');
    for (const w of r.working) out.push('   ' + w);
  });
  const t = savingTotals(rows);
  if (t.total > 0 || t.inv > 0) {
    let s = 'Total annual saving = ' + rs(t.total);
    if (t.hard && t.soft) s += ' (hard ' + rs(t.hard) + ' + soft ' + rs(t.soft) + ')';
    else if (t.soft && !t.hard) s += ' (soft saving)';
    if (t.inv > 0) s += '; total investment = ' + rs(t.inv) + (Number.isFinite(t.payback) ? '; payback = ' + fmt(t.payback, 1) + ' months' : '');
    out.push(s);
  }
  if (t.oneTime) out.push('One-time benefit = ' + rs(t.oneTime) + ' (shown separately, not part of the yearly saving)');
  if (t.avoided) out.push('Safety cost avoided = ' + rs(t.avoided) + ' per year, risk-based (shown separately, not part of the yearly saving)');
  return out.join('\n');
}

/**
 * What the calculator hands the sheet: its lines, the working, and the two rupee boxes it
 * fills. `annualSaving` is hard + soft per year (a negative total is 0: the box takes ₹0 up);
 * `implementationCost` is the investment across lines. Null when no line calculates, or
 * when a total is no rupee figure the sheet can hold (a 0 shift or wage divides by zero).
 */
export function savingSummary(lines: readonly KaizenSavingLine[]): { annualSaving: number; implementationCost: number; working: string } | null {
  const results = lines.map(calcSavingLine);
  if (!results.some(Boolean)) return null;
  const t = savingTotals(results);
  const round = (x: number) => Math.round(Math.max(0, x) * 100) / 100;
  const annualSaving = round(t.total), implementationCost = round(t.inv);
  if (!rupeesSchema.safeParse(annualSaving).success || !rupeesSchema.safeParse(implementationCost).success) return null;
  return { annualSaving, implementationCost, working: savingsText(results) };
}

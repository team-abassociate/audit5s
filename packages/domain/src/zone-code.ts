import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN, type Role } from '@audit5s/contracts';
import { formatDate } from './datetime';

/**
 * Zone codes.
 *
 * The stored `code` is free-form and unique per Unit (ARCHITECTURE.md §5.3, e.g. `Z-01`).
 * What a person types and reads is the Zone's *label* — `7`, `1A`, `12B`: one to three
 * letters or digits (R-52) — stored as `Z-07`, `Z-1A`, `Z-12B` by these helpers, so the
 * web, the device and the reports spell it the same way.
 */

const NUMERIC_CODE = /^Z-0*(\d+)$/;
const LABEL_CODE = /^Z-0*([0-9A-Z]{1,3})$/;
const LABEL = /^[0-9A-Z]{1,3}$/;

/** `1` → `Z-01`. Two digits below 100 so a plain lexical sort is also the numeric one. */
export function zoneCodeForNumber(zoneNumber: number): string {
  return `Z-${String(zoneNumber).padStart(2, '0')}`;
}

/**
 * R-52: what was typed in the Zone field → the stored code, or `null` if it is not one to
 * three letters or digits. `7` → `Z-07` (as a number always was), `1a` → `Z-1A`. Leading
 * zeros are dropped, so `07` and `7` cannot become two Zones.
 */
export function zoneCodeForLabel(label: string): string | null {
  const clean = label.trim().toUpperCase().replace(/^0+(?=.)/, '');
  if (!LABEL.test(clean) || clean === '0') return null;
  return /^\d+$/.test(clean) ? zoneCodeForNumber(Number(clean)) : `Z-${clean}`;
}

/** `Z-07` → `7`, `Z-1A` → `1A`; `null` for a code a Unit chose for itself (`BOILER`). */
export function zoneLabelFromCode(code: string): string | null {
  return LABEL_CODE.exec(code.trim().toUpperCase())?.[1] ?? null;
}

/**
 * A label as the Zone form types it: the number on a number pad, and a subzone letter only
 * when the Unit has subzones. `1A` → `1` and `A`; `7` → `7` and ``.
 */
export function zoneLabelParts(label: string): { number: string; subzone: string } {
  const clean = label.trim().toUpperCase();
  return { number: clean.replace(/\D/g, ''), subzone: /[A-Z]$/.exec(clean)?.[0] ?? '' };
}

/** Where a labelled Zone sorts: by its leading number, so `1A` sits beside `1`. */
export function zoneSortOrder(label: string): number {
  return Number.parseInt(label, 10) || 0;
}

/** The number behind a generated code, or `null` for a code a Unit chose for itself. */
export function zoneNumberFromCode(code: string): number | null {
  const match = NUMERIC_CODE.exec(code.trim().toUpperCase());
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

/** The Zone 1…100 the dropdown offers, in order. */
export function zoneCodeChoices(): Array<{ number: number; code: string }> {
  const choices: Array<{ number: number; code: string }> = [];
  for (let zoneNumber = ZONE_NUMBER_MIN; zoneNumber <= ZONE_NUMBER_MAX; zoneNumber += 1) {
    choices.push({ number: zoneNumber, code: zoneCodeForNumber(zoneNumber) });
  }
  return choices;
}

/**
 * How a Zone is written wherever it is shown to a person, including the reports:
 * `Zone 1 — Press` or `Zone 1A — Press` for a labelled code, `BOILER — Boiler house` for a custom one.
 * Defined once so the web, the device and the PDF cannot disagree.
 */
export function zoneDisplayLabel(code: string, name: string): string {
  const label = zoneLabelFromCode(code);
  if (label === null) return `${code} — ${name}`;
  const plain = `Zone ${label}`;
  // A Zone an auditor added by number (R-19) is named just that: "Zone 7 — Zone 7" says it twice.
  const trimmed = name.trim();
  return trimmed === '' || trimmed.toLocaleLowerCase() === plain.toLocaleLowerCase()
    ? plain
    : `${plain} — ${name}`;
}

/**
 * How the reports name a Zone: `zoneDisplayLabel`, then what the auditor called it.
 *
 * A Zone added by number (R-19) is named just "Zone 7", and what the auditor typed about it
 * on the phone — "Press shop", "Dispatch bay" — lives in its description. Printing the
 * number alone tells a reader of a twenty-Zone summary nothing, so the auditor's words
 * follow it, after any name somebody chose:
 *
 * - `Z-07`, "Zone 7", "Press shop"       → `Zone 7 — Press shop`
 * - `Z-07`, "Press", "Line 2, dies 4–6"  → `Zone 7 — Press — Line 2, dies 4–6`
 * - `Z-07`, "Press", "press"             → `Zone 7 — Press`
 * - `Z-07`, "Zone 7", nothing typed      → `Zone 7`
 * - `BOILER`, "Boiler house", nothing    → `BOILER — Boiler house` (a code a Unit chose)
 *
 * The number is written "Zone 7", never the stored `Z-07`, as on the Zone report and in the
 * sample reports. The description is a multi-line field on the phone; it
 * is printed on one line here.
 */
export function reportZoneLabel(zone: {
  zoneCode: string;
  zoneName: string;
  zoneDescription?: string | null;
}): string {
  const label = zoneDisplayLabel(zone.zoneCode, zone.zoneName);
  const described = (zone.zoneDescription ?? '').replace(/\s+/g, ' ').trim();
  if (described === '') return label;
  // Not said twice: a description that only repeats the name adds nothing.
  if (described.toLocaleLowerCase() === zone.zoneName.trim().toLocaleLowerCase()) return label;
  return `${label} — ${described}`;
}

/**
 * The leader an audit Zone snapshots when the auditor may have typed a name (R-19).
 *
 * The typed name is what the reports print. The Zone's leader account is kept only when the
 * name is that person's — otherwise the snapshot would print one person and point at another.
 * Nothing typed means the Zone's own leader, account and name alike.
 */
export function zoneLeaderSnapshot(
  zone: { zoneLeaderId: string | null; zoneLeaderName: string | null } | null | undefined,
  typedName: string | null | undefined,
): { userId: string | null; name: string | null } {
  const ownId = zone?.zoneLeaderId ?? null;
  const ownName = zone?.zoneLeaderName ?? null;
  const typed = typedName?.trim() || null;
  if (!typed) return { userId: ownId, name: ownName };
  const same = ownName !== null && ownName.trim().toLocaleLowerCase() === typed.toLocaleLowerCase();
  return { userId: same ? ownId : null, name: typed };
}

/**
 * R-52, R-59: who may add a Zone on Select Zone — a Super Admin or a Coordinator always, a
 * Consultant only while the Unit has no imported Zone list. `app_ensure_zone_for_audit`
 * (0054) enforces the same rule on the server.
 */
export function mayAddZoneWhileAuditing(role: Role | undefined, unitHasZoneList: boolean): boolean {
  return role === 'SUPER_ADMIN' || role === 'COORDINATOR' || (role === 'CONSULTANT' && !unitHasZoneList);
}

/**
 * Zone codes as a reader scans them: labels, each once, in ascending order — `Z-07`, `Z-01`,
 * `Z-1A` → `1`, `1A`, `7`. A code a Unit chose for itself (`BOILER`) keeps its own spelling
 * and sorts after the numbers.
 */
export function zoneLabelsAscending(codes: readonly string[]): string[] {
  const labels = new Set(codes.map((code) => zoneLabelFromCode(code) ?? code));
  return [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** `Zone 7`, `Zones 1, 4, 7`, or `''` for none — the one line an audit row names its Zones by. */
export function zonesLine(codes: readonly string[]): string {
  const labels = zoneLabelsAscending(codes);
  if (labels.length === 0) return '';
  return `${labels.length === 1 ? 'Zone' : 'Zones'} ${labels.join(', ')}`;
}

/**
 * A Unit's audit history by day: newest day first, and under each day every Zone audited
 * that day in ascending order, whoever audited it. The day is the one the audit finished on
 * (IST); an audit not finished yet is not history and is left out.
 */
export function auditDays<T extends { completedAt: string | null; zoneCodes?: readonly string[] }>(
  audits: readonly T[],
): Array<{ day: string; zones: string[]; audits: T[] }> {
  const finished = audits
    .filter((audit) => audit.completedAt !== null)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!));
  const days: Array<{ day: string; codes: string[]; audits: T[] }> = [];
  for (const audit of finished) {
    const day = formatDate(audit.completedAt);
    let last = days.at(-1);
    if (last?.day !== day) days.push((last = { day, codes: [], audits: [] }));
    last.codes.push(...(audit.zoneCodes ?? []));
    last.audits.push(audit);
  }
  return days.map(({ day, codes, audits: dayAudits }) => ({
    day,
    zones: zoneLabelsAscending(codes),
    audits: dayAudits,
  }));
}

import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from '@audit5s/contracts';

/**
 * Zone codes.
 *
 * The stored `code` is free-form and unique per Unit (ARCHITECTURE.md §5.3, e.g. `Z-01`).
 * What the auditor sees is a dropdown of Zone 1…100 (`brainstorm.md`), so the admin web
 * offers `Z-01`…`Z-100` from this helper rather than each screen inventing a format.
 */

const NUMERIC_CODE = /^Z-0*(\d+)$/;

/** `1` → `Z-01`. Two digits below 100 so a plain lexical sort is also the numeric one. */
export function zoneCodeForNumber(zoneNumber: number): string {
  return `Z-${String(zoneNumber).padStart(2, '0')}`;
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
 * `Zone 1 — Press` for a generated code, `Z-BOILER — Boiler house` for a custom one
 * (HANDOFF.md §4.1). Defined once so the web, the device and the PDF cannot disagree.
 */
export function zoneDisplayLabel(code: string, name: string): string {
  const zoneNumber = zoneNumberFromCode(code);
  return zoneNumber === null ? `${code} — ${name}` : `Zone ${zoneNumber} — ${name}`;
}

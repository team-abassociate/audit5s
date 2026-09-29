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
  if (zoneNumber === null) return `${code} — ${name}`;
  const plain = `Zone ${zoneNumber}`;
  // A Zone an auditor added by number (R-19) is named just that: "Zone 7 — Zone 7" says it twice.
  const trimmed = name.trim();
  return trimmed === '' || trimmed.toLocaleLowerCase() === plain.toLocaleLowerCase()
    ? plain
    : `${plain} — ${name}`;
}

/**
 * How the reports name a Zone: its number, then what the auditor called it.
 *
 * A Zone added by number (R-19) is named just "Zone 7", and what the auditor typed about it
 * on the phone — "Press shop", "Dispatch bay" — lives in its description. Printing code and
 * name alone gave `Z-07 — Zone 7`, which tells a reader of a twenty-Zone summary nothing.
 * So the automatic name gives way to the auditor's words, and a name somebody chose is kept
 * beside them:
 *
 * - `Z-07`, "Zone 7", "Press shop"       → `Z-07 — Press shop`
 * - `Z-07`, "Press", "Line 2, dies 4–6"  → `Z-07 — Press — Line 2, dies 4–6`
 * - `Z-07`, "Press", "press"             → `Z-07 — Press`
 * - `Z-07`, "Zone 7", nothing typed      → `Z-07 — Zone 7`, exactly as before
 *
 * The description is a multi-line field on the phone; it is printed on one line here.
 */
export function reportZoneLabel(zone: {
  zoneCode: string;
  zoneName: string;
  zoneDescription?: string | null;
}): string {
  const name = zone.zoneName.trim();
  const zoneNumber = zoneNumberFromCode(zone.zoneCode);
  const automatic =
    name === '' ||
    (zoneNumber !== null && name.toLocaleLowerCase() === `zone ${zoneNumber}`.toLocaleLowerCase());
  const described = (zone.zoneDescription ?? '').replace(/\s+/g, ' ').trim();

  const parts = [zone.zoneCode];
  if (!automatic) parts.push(name);
  if (described !== '' && described.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
    parts.push(described);
  }
  // Nothing but the code: say "Zone 7" rather than leave a bare code.
  if (parts.length === 1 && name !== '') parts.push(name);
  return parts.join(' — ');
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

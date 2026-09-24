/**
 * Which template rendered a snapshot (§5.8's `template_version`).
 *
 * Bump it when the layout changes in a way that would make a re-render differ from the
 * document already issued. It is recorded on every snapshot, so "why does v3 look unlike
 * v1" has an answer that does not require reading git history.
 *
 * It is also the byte-stability suite's canary: the fixed-payload fixture pins this value,
 * so changing the layout without acknowledging it fails there rather than in front of a
 * customer holding two reports that should have matched.
 */
/*
 * 1.1.0 — the corrective-action link became a scannable block (QR code, the address in
 * full, and the whole card as the tap target) instead of a line of 7.5 pt text. A report
 * re-rendered under this version will not match a 1.0.0 document byte for byte, which is
 * what the bump is for: the two are meant to differ, and the snapshot records which one
 * a reader is holding.
 */
// 1.2.0 — reference-led maroon report theme, quieter layout and single page footer.
// 1.3.0 — the rating key sits under the S-wise table, the zone checklist opens its own
// page, and no checklist row is split across a page break.
export const TEMPLATE_VERSION = '1.3.0';

/** §10.5: the renderer selects by the payload's schema version, not by today's code. */
export const SUPPORTED_PAYLOAD_SCHEMA_VERSIONS = [1] as const;

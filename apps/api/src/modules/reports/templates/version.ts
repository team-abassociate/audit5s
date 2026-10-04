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
// 1.4.0 — the summary names each Zone as the auditor did: `Zone 1 — Press Shop` rather than
// `Z-01 — Zone 1`, in the matrix, the comparison chart, the rankings and the flagged photos.
// 1.5.0 — the Zone report's Zone box reads the same way: `Zone 1 — Press Shop`, where it
// printed `Zone Z-01 — Zone 1` and left out what the auditor typed.
// 1.6.0 — R-38: the auditor's overall remark moves after the photo evidence, followed by
// the overall corrective-action suggestions, each with its own link and outcome.
// 1.7.0 — proposed R-45(b): dates print in India Standard Time with the domain formatter
// ("30 Sept 2026"), where they printed the UTC day as "30 Sep 2026". A report rendered
// between 18:30 and 24:00 UTC now names the IST day.
// 1.8.0 — UX audit R2: the rating key is square outlined chips with the admin app's band
// shapes (▲ ● ◆ ▼), where it was filled, rounded capsules. Issued PDFs keep their bytes (R-35).
export const TEMPLATE_VERSION = '1.8.0';

/** §10.5: the renderer selects by the payload's schema version, not by today's code. */
export const SUPPORTED_PAYLOAD_SCHEMA_VERSIONS = [1] as const;

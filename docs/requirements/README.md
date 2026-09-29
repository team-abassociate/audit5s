# Source requirements

The inputs the platform is built from. `ARCHITECTURE.md` (behaviour), `STACK.md` (technology)
and `DECISIONS.md` (tie-breaker) at the repo root are binding; `HANDOFF.md` explains how these
files relate to them and corrects the assumptions the blueprint made before these files were
available.

| File | Role |
| --- | --- |
| `brainstorm.md` | Original stakeholder narrative — screens, flows, button names, photo and report wishes. UI copy and field behaviour; not architecture. |
| `architecture-brief.md` | The engineering brief that `ARCHITECTURE.md` answers — roles, stack, modules, invariants, deliverables. |
| `5S_lean_audit_data_1.xlsx` | Department checklist workbook. Nine department sheets × 50 questions; the first three sheets are legacy planning sheets and are not imported. Seed-data truth for `ChecklistTemplate` v1. |
| `5S_lean_audit_data_1_hindi_marathi.xlsx` | The same workbook with `Check Point (Hindi)` and `Check Point (Marathi)` columns filled in on every department sheet. The editable master for translations: correct a cell and re-import it through the admin web, and only the translations are saved — no new checklist version, the English unchanged (migrations 0036–0037). Imported as it stands, every sheet reads *Translations only*. The seed and the import tests read the original, not this. |
| `sample-zone-report.pdf` | Hand-issued Zone report (Sahney Kirkwood, Zone 1 — Press). Visual truth for `INITIAL_ZONE` / `AFTER_EVIDENCE_ZONE`. |
| `sample-summary-report.pdf` | Hand-issued 22-zone summary. Visual truth for `MULTI_ZONE_SUMMARY`. |

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
| `sample-zone-report.pdf` | Hand-issued Zone report (Sahney Kirkwood, Zone 1 — Press). Visual truth for `INITIAL_ZONE` / `AFTER_EVIDENCE_ZONE`. |
| `sample-summary-report.pdf` | Hand-issued 22-zone summary. Visual truth for `MULTI_ZONE_SUMMARY`. |

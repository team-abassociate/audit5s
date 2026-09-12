-- The Unit `code` is gone.
--
-- It was a short handle a Super Admin had to invent at creation and could never change,
-- justified in §12.5 by object-storage keys "embedding" it. They never did: every key in
-- `packages/domain/src/evidence.ts` is built from `unit_id`. That left a second identifier
-- for a row that already has a name, printed as "Name (CODE)" on every report and picker.
--
-- The name carries the uniqueness instead. Nothing references `unit.code` by foreign key,
-- so the drop is a column drop and an index swap.

DROP INDEX unit_code_key;
ALTER TABLE unit DROP COLUMN code;
CREATE UNIQUE INDEX unit_name_key ON unit (name);

-- The quarantine kept what the device sent and the category it fell into, and threw away
-- the sentence that explained which rule refused it: `classifyFailure` builds that sentence
-- and passes it to the logger alone. A Super Admin reading Sync Health therefore saw
-- "Payload could not be read" over a payload that looked perfectly well formed, and could
-- not tell an unregistered device from a duplicated id without a shell on the box.
--
-- That is the wrong side of §9.5's bargain. The quarantine exists so a refusal costs a
-- diagnosis rather than a day's field work, and a diagnosis nobody can read is not one.
--
-- Nullable, and deliberately not backfilled: every row quarantined before this migration
-- has no such record, and inventing a plausible reason for one is worse than showing that
-- it was never kept.
ALTER TABLE sync_conflict ADD COLUMN detail text NULL;

COMMENT ON COLUMN sync_conflict.detail IS
  'Why the server refused the item, in its own words. Null for rows quarantined before 0020.';

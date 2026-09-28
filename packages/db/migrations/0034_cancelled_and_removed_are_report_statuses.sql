-- =============================================================================
-- 0034 — CANCELLED and REMOVED are report statuses
--
-- A Super Admin who presses Generate twice queues two renders of the same document, and a
-- report issued by mistake stayed in every list for good. Two ways out:
--
--   * CANCELLED — a report stopped before it was rendered (QUEUED or RENDERING). No PDF was
--     issued, so nothing is lost.
--   * REMOVED   — a rendered (READY) or FAILED report taken out of circulation. The row stays
--     as the record that it existed, what it was of, and its checksum; the PDF object is
--     deleted to free the space. 0035 is the RS-1 carve-out that allows exactly that.
--
-- The values are added here, alone, because Postgres will not let a transaction use an enum
-- value it added itself, and the migration runner gives every file one transaction (the
-- same split as 0030/0031). 0035 puts them to use.
-- =============================================================================

ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'REMOVED';

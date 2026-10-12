-- =============================================================================
-- 0047 — A browser registers as a device
--
-- Owner, 2026-10-12 (DECISIONS.md R-51): the admin web conducts audits too. An audit is
-- owned by one device while it is in progress (D7), so the browser that runs one registers
-- itself as a device with platform 'web' — the single-writer lock is unchanged, it simply
-- has a third kind of holder. Additive only: the release before this one never sends 'web'.
-- =============================================================================

ALTER TABLE device DROP CONSTRAINT device_platform_check;
ALTER TABLE device ADD CONSTRAINT device_platform_check CHECK (platform IN ('android', 'ios', 'web'));

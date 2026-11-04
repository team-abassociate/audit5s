-- =============================================================================
-- 0065 — A Zone's past audits are compared by the name they were taken under (R-83)
--
-- Owner, 2026-11-04: a Zone list import updates Zones by number, so after a renumbering an
-- old audit stayed on a record that now names another department, and its marks read as
-- that department's. Comparisons now follow the audit's frozen name: the Zone an audit
-- belongs to, for any comparison, is the one with that name today.
--
-- A record that still has the name keeps its own audits, so two Zones sharing a name are
-- not merged. An archived record gives way to a live one, because an import that moves a
-- Zone to a new number archives the old record with its name intact. An audit whose name no
-- Zone has now compares with nothing but audits of its own name.
--
-- A Unit may also set its earlier audits aside. Owner, same day: Sahney Kirkwood's audits of
-- 2026-09-23 were real, but they stay out of every comparison and of Unit analytics, and their
-- NCs stay out of the working lists, the reminders and the open counts. No audit or NC is deleted or changed: the audits,
-- their reports and their NCs remain, and the NCs can still be opened from their audit. Only
-- the derived daily totals are recalculated, at the end of this file.
-- =============================================================================

ALTER TABLE unit ADD COLUMN audits_set_aside_before timestamptz;

CREATE FUNCTION app_audit_set_aside(p_audit_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM audit a
    JOIN unit u ON u.id = a.unit_id
    WHERE a.id = p_audit_id AND a.started_at < u.audits_set_aside_before
  )
$$;

CREATE FUNCTION app_zone_name_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
$$;

CREATE FUNCTION app_comparison_zone(p_audit_zone_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT z.id
  FROM audit_zone az
  JOIN audit a ON a.id = az.audit_id
  JOIN zone z
    ON z.unit_id = a.unit_id
   AND app_zone_name_key(z.name) = app_zone_name_key(az.zone_name_snapshot)
  WHERE az.id = p_audit_zone_id AND NOT app_audit_set_aside(az.audit_id)
  ORDER BY (z.archived_at IS NULL) DESC, (z.id = az.zone_id) DESC, z.code
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION app_audit_set_aside(uuid) TO audit5s_app;
GRANT EXECUTE ON FUNCTION app_zone_name_key(text) TO audit5s_app;
GRANT EXECUTE ON FUNCTION app_comparison_zone(uuid) TO audit5s_app;

-- Sahney Kirkwood: everything before 1 October 2026 in India.
UPDATE unit SET audits_set_aside_before = '2026-09-30T18:30:00Z'
WHERE id = '0650d48f-da86-46b3-81ed-087eb5371b4a';

-- The stored daily totals already counted those audits and their NCs. The rollup leaves them
-- out from now on but rebuilds only recent days, so Sahney's are corrected here, once. No other
-- audit began before October at Sahney, so its earlier days hold nothing else.
UPDATE metric_daily_unit SET
  audit_count = 0, completed_count = 0, raw_score = 0, max_score = 0, avg_score = NULL,
  score_sample_count = 0, active_auditors = 0
WHERE unit_id = '0650d48f-da86-46b3-81ed-087eb5371b4a' AND day < '2026-10-01';

UPDATE metric_daily_zone SET
  audit_count = 0, raw_score = 0, max_score = 0, last_score = NULL, avg_score = NULL,
  score_sample_count = 0
WHERE unit_id = '0650d48f-da86-46b3-81ed-087eb5371b4a' AND day < '2026-10-01';

UPDATE metric_section_daily SET
  raw_score = 0, max_score = 0, avg_score_percentage = NULL, sample_count = 0
WHERE unit_id = '0650d48f-da86-46b3-81ed-087eb5371b4a' AND day < '2026-10-01';

UPDATE metric_daily_unit m SET (open_nc, closed_nc, avg_closure_hours) = (
  SELECT
    count(*) FILTER (WHERE ca.opened_at < t.day_end AND (ca.resolved_at IS NULL OR ca.resolved_at >= t.day_end))::int,
    count(*) FILTER (WHERE ca.resolved_at >= t.day_start AND ca.resolved_at < t.day_end AND ca.status <> 'WITHDRAWN')::int,
    avg(extract(epoch FROM (ca.resolved_at - ca.opened_at)) / 3600)
      FILTER (WHERE ca.resolved_at >= t.day_start AND ca.resolved_at < t.day_end AND ca.status <> 'WITHDRAWN')
  FROM (
    SELECT m.day::timestamp AT TIME ZONE u.timezone AS day_start,
           (m.day + 1)::timestamp AT TIME ZONE u.timezone AS day_end
    FROM unit u WHERE u.id = m.unit_id
  ) t
  CROSS JOIN corrective_action ca
  WHERE ca.unit_id = m.unit_id AND NOT app_audit_set_aside(ca.audit_id)
)
WHERE m.unit_id = '0650d48f-da86-46b3-81ed-087eb5371b4a';

UPDATE metric_daily_zone m SET open_nc = (
  SELECT count(*)::int
  FROM unit u
  JOIN corrective_action ca ON ca.unit_id = u.id
  WHERE u.id = m.unit_id AND ca.zone_id = m.zone_id
    AND NOT app_audit_set_aside(ca.audit_id)
    AND ca.opened_at < (m.day + 1)::timestamp AT TIME ZONE u.timezone
    AND (ca.resolved_at IS NULL OR ca.resolved_at >= (m.day + 1)::timestamp AT TIME ZONE u.timezone)
)
WHERE m.unit_id = '0650d48f-da86-46b3-81ed-087eb5371b4a';

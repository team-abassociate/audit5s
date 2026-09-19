-- R-28: Consultants are an independent master list. An open audit assignment grants the
-- assigned Consultant temporary access to its Unit without manufacturing a permanent
-- unit_membership row. Existing RLS policies already call app_actor_unit_ids(), so keeping
-- this resolver authoritative updates Unit, Zone, audit and sync access together.

CREATE OR REPLACE FUNCTION app_actor_unit_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT scoped.unit_id), ARRAY[]::uuid[])
  FROM (
    SELECT m.unit_id
    FROM unit_membership m
    WHERE m.user_id = app_actor_id()
      AND m.status = 'ACTIVE'
      AND now() >= m.valid_from
      AND (m.valid_to IS NULL OR now() < m.valid_to)

    UNION

    SELECT aa.unit_id
    FROM audit_assignment aa
    WHERE app_actor_role() = 'CONSULTANT'
      AND aa.auditor_user_id = app_actor_id()
      AND aa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
  ) AS scoped;
$$;

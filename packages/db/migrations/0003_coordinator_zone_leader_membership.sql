-- =============================================================================
-- 0003_coordinator_zone_leader_membership
--
-- PART 6.3 gives `unit_membership:create` to SUPER_ADMIN alone, and 0001's RLS policy
-- implemented that literally. But the same matrix gives a COORDINATOR `user:create` scoped
-- to `own_unit` with the target role fixed to ZONE_LEADER — and creating a scoped user
-- *is* creating their membership: a Zone Leader with no Unit has no scope and can see
-- nothing.
--
-- So the two rows were in tension, and the literal reading made the Coordinator's own
-- granted operation fail. The membership row here is not an independent assignment; it is
-- the Unit half of the user the Coordinator was already permitted to create.
--
-- The widening is exactly that and no more: their own active Unit, role ZONE_LEADER,
-- status ACTIVE. A Coordinator still cannot assign anyone to another Unit, cannot assign a
-- Consultant or Coordinator, and cannot revoke anything — `unit_membership_update` remains
-- SUPER_ADMIN-only, so revocation is untouched.
-- =============================================================================

DROP POLICY unit_membership_insert ON unit_membership;

CREATE POLICY unit_membership_insert ON unit_membership FOR INSERT
  WITH CHECK (
    app_is_super_admin()
    OR (
      app_actor_role() = 'COORDINATOR'
      AND role = 'ZONE_LEADER'
      AND status = 'ACTIVE'
      AND unit_id = ANY (app_actor_unit_ids())
    )
  );

-- =============================================================================
-- 0010_reports
--
-- Phase 7 schema (ARCHITECTURE.md PART 14): `report_snapshot`, `report_access_token`,
-- and the foreign key 0009 left dangling on `corrective_action_submission`.
--
-- Database guarantees in this file:
--
--   * RS-1 — a READY snapshot is immutable. Regeneration inserts a new row with
--     `version + 1` and `supersedes_snapshot_id`; there is no UPDATE path that changes a
--     READY row's `payload` or `pdf_object_key`. The trigger below is what makes that a
--     database guarantee rather than a convention the render worker happens to follow —
--     and it is the reason "regeneration leaves v1 byte-identical" is a property of the
--     schema, not of the code that usually does the right thing.
--   * `UNIQUE(audit_zone_id, kind, version)` — two Super Admins pressing Generate at the
--     same moment produce one v2 and one 409, not two rows both calling themselves v2.
--   * A token's secret is never stored. `token_hash` is the SHA-256 of a 256-bit random
--     value that exists only inside the link, and it is UNIQUE so a hash collision is a
--     constraint violation rather than a second door to somebody else's finding.
--   * Nothing here is deleted (D8). Revocation is a column, not a DELETE.
-- =============================================================================

CREATE TYPE report_kind AS ENUM ('INITIAL_ZONE','AFTER_EVIDENCE_ZONE','MULTI_ZONE_SUMMARY');
CREATE TYPE report_status AS ENUM ('QUEUED','RENDERING','READY','FAILED');

-- =============================================================================
-- report_snapshot (§5.8)
-- =============================================================================

CREATE TABLE report_snapshot (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    report_kind NOT NULL,
  -- 1, 2, 3… never overwritten. The chain is the evidence an external certification body
  -- needs: what was issued, on what date, and what it said then.
  version                 integer NOT NULL,
  supersedes_snapshot_id  uuid NULL REFERENCES report_snapshot(id) ON DELETE RESTRICT,
  unit_id                 uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  -- Null for a summary spanning several audits.
  audit_id                uuid NULL REFERENCES audit(id) ON DELETE RESTRICT,
  audit_zone_id           uuid NULL REFERENCES audit_zone(id) ON DELETE RESTRICT,
  -- The exact selection for a MULTI_ZONE_SUMMARY, so the report is reproducible and its
  -- scope unambiguous. A summary is never a slice of a Unit-wide figure (§10.3-C).
  selected_zone_ids       uuid[] NULL,
  -- THE frozen data (§10.1). Everything the PDF prints; nothing it looks up at render.
  payload                 jsonb NOT NULL,
  payload_schema_version  integer NOT NULL DEFAULT 1,
  template_version        text NOT NULL,
  status                  report_status NOT NULL DEFAULT 'QUEUED',
  pdf_object_key          text NULL,
  pdf_checksum_sha256     text NULL,
  page_count              integer NULL,
  generated_by_user_id    uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  generated_at            timestamptz NOT NULL DEFAULT now(),
  rendered_at             timestamptz NULL,
  failed_reason           text NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_snapshot_version CHECK (version >= 1),
  -- A zone report names a Zone; a summary names a selection. Neither shape can be half
  -- filled in, because a renderer given both would have to guess which one it is.
  CONSTRAINT report_snapshot_target CHECK (
    (kind IN ('INITIAL_ZONE','AFTER_EVIDENCE_ZONE')
       AND audit_zone_id IS NOT NULL AND audit_id IS NOT NULL AND selected_zone_ids IS NULL)
    OR (kind = 'MULTI_ZONE_SUMMARY'
       AND audit_zone_id IS NULL AND selected_zone_ids IS NOT NULL
       AND cardinality(selected_zone_ids) > 0)
  ),
  -- A READY snapshot has its object; a FAILED one has its reason. Neither half-state is
  -- reachable, so a download route never has to wonder.
  CONSTRAINT report_snapshot_ready CHECK (
    status <> 'READY' OR (pdf_object_key IS NOT NULL AND pdf_checksum_sha256 IS NOT NULL)
  ),
  CONSTRAINT report_snapshot_failed CHECK (
    status <> 'FAILED' OR failed_reason IS NOT NULL
  )
);

-- The version chain per target. UNIQUE rather than an index: it is what stops two
-- concurrent Generate presses from both minting v2.
CREATE UNIQUE INDEX report_snapshot_zone_version_key
  ON report_snapshot (audit_zone_id, kind, version) WHERE audit_zone_id IS NOT NULL;
CREATE INDEX report_snapshot_audit_idx ON report_snapshot (audit_id, kind, version DESC);
CREATE INDEX report_snapshot_unit_idx ON report_snapshot (unit_id, generated_at DESC);
CREATE INDEX report_snapshot_status_idx ON report_snapshot (status);
-- Report search over the frozen payload (§5.8).
CREATE INDEX report_snapshot_payload_gin ON report_snapshot USING gin (payload);

CREATE TRIGGER report_snapshot_set_updated_at BEFORE UPDATE ON report_snapshot
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER report_snapshot_no_delete BEFORE DELETE ON report_snapshot
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

/*
 * RS-1, as a database guarantee.
 *
 * A snapshot is mutable exactly once, along one path: QUEUED → RENDERING → READY|FAILED,
 * which is the worker filling in what it produced. Once it is READY nothing changes, and
 * in particular `payload` and `pdf_object_key` never change at any status — a payload
 * rewritten in place would silently reissue a document somebody has already been sent.
 *
 * Written as its own function rather than `enforce_append_only()` for the same reason A-2
 * and R-10 needed theirs: the generic trigger freezes a table from its first row, and a
 * snapshot has a life between being queued and being rendered.
 */
CREATE OR REPLACE FUNCTION enforce_report_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'READY' THEN
    RAISE EXCEPTION
      'Report snapshot % is READY and immutable (RS-1). Regeneration inserts version %, '
      'it does not rewrite this one',
      OLD.id, OLD.version + 1
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.audit_zone_id IS DISTINCT FROM OLD.audit_zone_id
     OR NEW.selected_zone_ids IS DISTINCT FROM OLD.selected_zone_ids
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION
      'Report snapshot %: the frozen payload and what it is a report *of* never change '
      '(RS-1). A different document is a new version',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE ON report_snapshot
  FOR EACH ROW EXECUTE FUNCTION enforce_report_snapshot_immutable();

-- =============================================================================
-- report_access_token (§5.8, §10.4)
-- =============================================================================

CREATE TABLE report_access_token (
  -- = the JTI. The link carries the secret, not this; this is what a revoke names.
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of a 256-bit random secret. The raw value exists only in the link, so an
  -- invalid token and an expired one are indistinguishable from outside — no enumeration.
  token_hash           text NOT NULL,
  purpose              text NOT NULL,
  snapshot_id          uuid NULL REFERENCES report_snapshot(id) ON DELETE RESTRICT,
  -- Single-item audience (§10.4): the token names one corrective action, and there is no
  -- listing route on the public surface for it to reach anything else through.
  corrective_action_id uuid NULL REFERENCES corrective_action(id) ON DELETE RESTRICT,
  -- Scope guard even for token access: the public surface still resolves a scope.
  unit_id              uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  -- The Zone Leader the action is assigned to, where there is one. It is also who a
  -- submission through this link is attributed to — the public page has no session.
  issued_to_user_id    uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  expires_at           timestamptz NOT NULL,
  max_uses             integer NULL,
  use_count            integer NOT NULL DEFAULT 0,
  last_used_at         timestamptz NULL,
  last_used_ip         text NULL,
  revoked_at           timestamptz NULL,
  revoked_by_user_id   uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  revoke_reason        text NULL,
  created_by_user_id   uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_access_token_purpose CHECK (purpose IN ('CORRECTIVE_ACTION','VIEW_REPORT')),
  -- A corrective-action token without its action would authorize nothing in particular,
  -- which is precisely the shape a single-item audience exists to prevent.
  CONSTRAINT report_access_token_audience CHECK (
    (purpose = 'CORRECTIVE_ACTION' AND corrective_action_id IS NOT NULL)
    OR (purpose = 'VIEW_REPORT' AND snapshot_id IS NOT NULL)
  ),
  CONSTRAINT report_access_token_uses CHECK (use_count >= 0 AND (max_uses IS NULL OR max_uses > 0)),
  CONSTRAINT report_access_token_revoked CHECK (
    (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX report_access_token_hash_key ON report_access_token (token_hash);
CREATE INDEX report_access_token_action_idx ON report_access_token (corrective_action_id);
CREATE INDEX report_access_token_expiry_idx ON report_access_token (expires_at);
CREATE INDEX report_access_token_snapshot_idx ON report_access_token (snapshot_id, revoked_at);

CREATE TRIGGER report_access_token_set_updated_at BEFORE UPDATE ON report_access_token
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A revoked token stays, with who revoked it and why. Deleting one would erase the only
-- record that a link existed and was used (§10.4's "auditable").
CREATE TRIGGER report_access_token_no_delete BEFORE DELETE ON report_access_token
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- The hash and the audience never change. A token that could be re-pointed at another
-- finding is a different token, and minting one costs nothing.
CREATE OR REPLACE FUNCTION enforce_report_token_audience_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.corrective_action_id IS DISTINCT FROM OLD.corrective_action_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'Report access token %: its secret, its audience and its expiry are fixed at minting. '
      'Revoke it and mint another',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_access_token_audience_fixed BEFORE UPDATE ON report_access_token
  FOR EACH ROW EXECUTE FUNCTION enforce_report_token_audience_fixed();

-- =============================================================================
-- The foreign key 0009 could not write yet
-- =============================================================================

-- "The FK lands with `report_access_token` in Phase 7, for the reason every seam in this
-- schema waited: no referent yet." It has one now.
ALTER TABLE corrective_action_submission
  ADD CONSTRAINT corrective_action_submission_access_token_fk
  FOREIGN KEY (access_token_id) REFERENCES report_access_token(id) ON DELETE RESTRICT;

CREATE INDEX corrective_action_submission_token_idx
  ON corrective_action_submission (access_token_id) WHERE access_token_id IS NOT NULL;

-- =============================================================================
-- Row-level security — PART 6.3, as defence in depth behind the ScopeGuard
-- =============================================================================

ALTER TABLE report_snapshot     ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_access_token ENABLE ROW LEVEL SECURITY;

-- `report:read_snapshot` / `report:download` — SA `organization`, COO and ZL `own_unit`.
-- A Consultant holds neither cell and so matches nothing here (N5/C4): their read model
-- is `GET /audits/{id}/summary`, which is not a report.
CREATE POLICY report_snapshot_select ON report_snapshot FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

-- `report:generate` is Super Admin only, and so is the worker's own write-back: the
-- render runs as the Super Admin who asked for it.
CREATE POLICY report_snapshot_insert ON report_snapshot FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY report_snapshot_update ON report_snapshot FOR UPDATE
  USING (app_is_super_admin());

-- `report_access_token:mint` / `:revoke` — Super Admin, `organization`.
CREATE POLICY report_access_token_admin ON report_access_token FOR ALL
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

/*
 * Validating a link is a pre-authentication read, and it is the same problem `/auth/login`
 * has: the credential must be looked up before any actor exists. So it reuses the same
 * mechanism rather than inventing a second one — `app_in_auth_phase()`, entered explicitly
 * by the token repository's lookup, which resolves the token and records its use in one
 * transaction and then hands the request an ordinary Zone Leader actor.
 *
 * The window is not a hole: the lookup is by `token_hash`, a 256-bit secret that exists
 * only inside the link, exactly as the login lookup is by a login ID plus a verifier.
 */
CREATE POLICY report_access_token_validate ON report_access_token FOR SELECT
  USING (app_in_auth_phase());
CREATE POLICY report_access_token_record_use ON report_access_token FOR UPDATE
  USING (app_in_auth_phase())
  WITH CHECK (app_in_auth_phase());

-- =============================================================================
-- Grants — no DELETE on either (D8). The triggers refuse it anyway.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON report_snapshot     TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON report_access_token TO audit5s_app;

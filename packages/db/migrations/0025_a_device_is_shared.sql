-- =============================================================================
-- 0025 — A phone is shared, and everybody who signs in on it properly may use it
--
-- A plant has fewer handsets than auditors. Until now `device.user_id` named one owner and
-- every sign-in moved it: the previous person's session kept working but every audit they
-- started was refused ("Somebody else has since signed in on this device"), and their
-- queued work went out under the next person's token and was quarantined.
--
-- A device is hardware; who may use it is a list. `device_user` is that list: a row per
-- person who has signed in on the phone with their own credentials, revocable one person
-- at a time. `device.user_id` stays, meaning only "who signed in last" — the Devices table
-- shows it, and nothing authorises against it any more.
-- =============================================================================

CREATE TABLE device_user (
  device_id          uuid        NOT NULL REFERENCES device(id) ON DELETE RESTRICT,
  user_id            uuid        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  first_signed_in_at timestamptz NOT NULL DEFAULT now(),
  last_signed_in_at  timestamptz NOT NULL DEFAULT now(),
  -- One person's access to this phone, withdrawn without touching anybody else's.
  revoked_at         timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);

CREATE INDEX device_user_user_idx ON device_user (user_id, revoked_at);

CREATE TRIGGER device_user_set_updated_at BEFORE UPDATE ON device_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Everybody who holds a phone today is on its list. Nothing else is known about who used
-- it before, and inventing earlier users would grant access nobody asked for.
INSERT INTO device_user (device_id, user_id, first_signed_in_at, last_signed_in_at, revoked_at)
SELECT id, user_id, created_at, COALESCE(last_seen_at, created_at), revoked_at
FROM device;

ALTER TABLE device_user ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_user_select ON device_user FOR SELECT
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY device_user_insert ON device_user FOR INSERT
  WITH CHECK (app_in_auth_phase() OR user_id = app_actor_id());

CREATE POLICY device_user_update ON device_user FOR UPDATE
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

GRANT SELECT, INSERT, UPDATE ON device_user TO audit5s_app;

-- The phone itself is visible to everybody on its list, not only to whoever signed in last.
DROP POLICY device_select ON device;
CREATE POLICY device_select ON device FOR SELECT
  USING (
    app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id()
    OR EXISTS (SELECT 1 FROM device_user du WHERE du.device_id = device.id AND du.user_id = app_actor_id())
  );

DROP POLICY device_update ON device;
CREATE POLICY device_update ON device FOR UPDATE
  USING (
    app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id()
    OR EXISTS (SELECT 1 FROM device_user du WHERE du.device_id = device.id AND du.user_id = app_actor_id())
  );

COMMENT ON COLUMN device.user_id IS
  'Who signed in on this phone last. Display only since 0025: access is device_user.';

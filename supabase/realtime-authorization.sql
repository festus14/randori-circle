-- #461 / ID-96. OPERATOR-APPLIED in the Supabase Dashboard SQL Editor only.
-- Not a Turso migration; never executed by an app request.
-- Precondition: a dedicated relay-only project, public channel access disabled.
-- See docs/CONFLICT_FREE_CODE_DOCUMENTS.md#supabase-provider-setup-and-rollback.
-- Restrictive policies are intentional: another permissive authenticated policy
-- must not widen this token's room scope or grant presence/database messages.
BEGIN;
-- Fail before any policy write unless RLS is (or, for the table owner, becomes)
-- enabled and this role may manage policies on realtime.messages. On Supabase the
-- table belongs to supabase_realtime_admin with RLS already on; the SQL Editor/API
-- role `postgres` is not the owner but is granted policy management on this exact
-- table by supautils.policy_grants. Never proceed with RLS off.
DO $rc_preflight$
DECLARE
  target oid;
  owner_role oid;
  rls_on boolean;
  may_own boolean;
  granted boolean;
BEGIN
  SELECT relation.oid, relation.relowner, relation.relrowsecurity
    INTO target, owner_role, rls_on
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
   WHERE namespace.nspname='realtime' AND relation.relname='messages' AND relation.relkind IN ('r','p');
  IF target IS NULL THEN
    RAISE EXCEPTION 'realtime.messages not found';
  END IF;
  may_own := pg_has_role(current_user,owner_role,'USAGE');
  granted := COALESCE((NULLIF(current_setting('supautils.policy_grants',true),'')::jsonb
    -> current_user::text) ? 'realtime.messages', false);
  IF NOT rls_on THEN
    IF may_own THEN
      EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
    ELSE
      RAISE EXCEPTION 'realtime.messages must have row level security enabled';
    END IF;
  END IF;
  IF NOT (may_own OR granted) THEN
    RAISE EXCEPTION 'Applying role must own realtime.messages or hold its supautils policy grant';
  END IF;
END;
$rc_preflight$;
DROP POLICY IF EXISTS rc_code_relay_read ON realtime.messages;
DROP POLICY IF EXISTS rc_code_relay_write ON realtime.messages;
DROP POLICY IF EXISTS rc_code_relay_read_scope ON realtime.messages;
DROP POLICY IF EXISTS rc_code_relay_write_scope ON realtime.messages;

CREATE POLICY rc_code_relay_read ON realtime.messages
AS PERMISSIVE FOR SELECT TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT auth.jwt()->>'role') = 'authenticated'
  AND (SELECT auth.jwt()->>'room') = (SELECT realtime.topic())
);
CREATE POLICY rc_code_relay_write ON realtime.messages
AS PERMISSIVE FOR INSERT TO authenticated
WITH CHECK (
  extension = 'broadcast'
  AND (SELECT auth.jwt()->>'role') = 'authenticated'
  AND (SELECT auth.jwt()->>'room') = (SELECT realtime.topic())
);

CREATE POLICY rc_code_relay_read_scope ON realtime.messages
AS RESTRICTIVE FOR SELECT TO public
USING (
  extension = 'broadcast'
  AND (SELECT auth.jwt()->>'role') = 'authenticated'
  AND (SELECT auth.jwt()->>'room') = (SELECT realtime.topic())
  AND (SELECT auth.jwt()->>'room') ~ '^rc-code:v1:week_[1-9][0-9]*_pair_[1-9][0-9]*:[a-f0-9]{64}$'
  AND (SELECT auth.jwt()->>'exp') ~ '^[0-9]{1,12}$'
  AND CASE WHEN (SELECT auth.jwt()->>'exp') ~ '^[0-9]{1,12}$'
    THEN (SELECT (auth.jwt()->>'exp')::bigint) > extract(epoch FROM now())
    ELSE false END
);
CREATE POLICY rc_code_relay_write_scope ON realtime.messages
AS RESTRICTIVE FOR INSERT TO public
WITH CHECK (
  extension = 'broadcast'
  AND (SELECT auth.jwt()->>'role') = 'authenticated'
  AND (SELECT auth.jwt()->>'room') = (SELECT realtime.topic())
  AND (SELECT auth.jwt()->>'room') ~ '^rc-code:v1:week_[1-9][0-9]*_pair_[1-9][0-9]*:[a-f0-9]{64}$'
  AND (SELECT auth.jwt()->>'exp') ~ '^[0-9]{1,12}$'
  AND CASE WHEN (SELECT auth.jwt()->>'exp') ~ '^[0-9]{1,12}$'
    THEN (SELECT (auth.jwt()->>'exp')::bigint) > extract(epoch FROM now())
    ELSE false END
);
-- Re-check after the writes: commit only with RLS still enabled.
DO $rc_postcheck$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass) THEN
    RAISE EXCEPTION 'realtime.messages row level security is not enabled';
  END IF;
END;
$rc_postcheck$;
COMMIT;

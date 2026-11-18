-- #461 / ID-96. OPERATOR-APPLIED in the Supabase Dashboard SQL Editor only.
-- Not a Turso migration; never executed by an app request.
-- Precondition: a dedicated relay-only project, public channel access disabled.
-- See docs/CONFLICT_FREE_CODE_DOCUMENTS.md#supabase-provider-setup-and-rollback.
-- Restrictive policies are intentional: another permissive authenticated policy
-- must not widen this token's room scope or grant presence/database messages.
BEGIN;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
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
COMMIT;

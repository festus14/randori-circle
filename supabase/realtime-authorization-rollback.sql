-- #461 emergency rollback: run ONLY after realtime-authorization.sql was applied.
-- First turn REALTIME_RELAY_ENABLED off and redeploy. Existing connections cache
-- authorization: revoke the imported signing key and disconnect provider sessions
-- when immediate cutoff is required. Do not remove these restrictive deny fences.
BEGIN;
DROP POLICY IF EXISTS rc_code_relay_read ON realtime.messages;
DROP POLICY IF EXISTS rc_code_relay_write ON realtime.messages;
ALTER POLICY rc_code_relay_read_scope ON realtime.messages USING (false);
ALTER POLICY rc_code_relay_write_scope ON realtime.messages WITH CHECK (false);
COMMIT;

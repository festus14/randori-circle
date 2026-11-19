import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const apply=readFileSync(new URL('../../supabase/realtime-authorization.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('../../supabase/realtime-authorization-rollback.sql',import.meta.url),'utf8');
const vercel=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
const policy=name=>apply.match(new RegExp(`CREATE POLICY ${name} ON realtime\\.messages\\s+([\\s\\S]*?);`))?.[1];

test('reviewed Realtime SQL has room-bound broadcast permissive policies plus all-role restrictive fences',()=>{
  // Preflight runs inside the transaction before any policy write: it requires RLS to be on (only the
  // owner may turn it on) and the applying role to own the table or hold Supabase's supautils policy grant.
  assert.match(apply,/BEGIN;[\s\S]*DO \$rc_preflight\$[\s\S]*relation\.relrowsecurity[\s\S]*pg_has_role\(current_user,owner_role,'USAGE'\)[\s\S]*current_setting\('supautils\.policy_grants',true\)[\s\S]*\? 'realtime\.messages'[\s\S]*IF NOT rls_on THEN[\s\S]*IF may_own THEN[\s\S]*EXECUTE 'ALTER TABLE realtime\.messages ENABLE ROW LEVEL SECURITY'[\s\S]*RAISE EXCEPTION 'realtime\.messages must have row level security enabled'[\s\S]*IF NOT \(may_own OR granted\) THEN[\s\S]*RAISE EXCEPTION 'Applying role must own realtime\.messages or hold its supautils policy grant'[\s\S]*\$rc_preflight\$;[\s\S]*DROP POLICY IF EXISTS rc_code_relay_read ON/);
  // RLS is never disabled, the only ALTER TABLE is the owner-only conditional, and commit re-checks RLS.
  assert.doesNotMatch(apply,/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/);
  assert.equal((apply.match(/ALTER TABLE/g)||[]).length,1);
  assert.match(apply,/DO \$rc_postcheck\$[\s\S]*relrowsecurity[\s\S]*RAISE EXCEPTION 'realtime\.messages row level security is not enabled'[\s\S]*\$rc_postcheck\$;\s*COMMIT;\s*$/);
  assert.equal((apply.match(/CREATE POLICY /g)||[]).length,4);
  for(const [action,kind,clause] of [['read','SELECT','USING'],['write','INSERT','WITH CHECK']]){
    const grant=policy(`rc_code_relay_${action}`),fence=policy(`rc_code_relay_${action}_scope`);
    assert.match(grant,new RegExp(`AS PERMISSIVE FOR ${kind} TO authenticated`));
    assert.match(fence,new RegExp(`AS RESTRICTIVE FOR ${kind} TO public`),'anon or broad permissive role cannot bypass room scope');
    for(const value of [grant,fence]){
      assert.match(value,new RegExp(`${clause} \\(`));
      assert.match(value,/extension = 'broadcast'/);
      assert.match(value,/auth\.jwt\(\)->>'role'\) = 'authenticated'/);
      assert.match(value,/auth\.jwt\(\)->>'room'\) = \(SELECT realtime\.topic\(\)\)/);
      assert.doesNotMatch(value,/\btrue\b|service_role/);
    }
    assert.match(fence,/\^rc-code:v1:week_\[1-9\]\[0-9\]\*_pair_\[1-9\]\[0-9\]\*:\[a-f0-9\]\{64\}\$/);
    assert.match(fence,/CASE WHEN[\s\S]*auth\.jwt\(\)->>'exp'[\s\S]*::bigint[\s\S]*> extract\(epoch FROM now\(\)\)[\s\S]*ELSE false END/);
  }
});

test('provider rollback removes permissive policies but retains deny-all restrictive policies and RLS',()=>{
  assert.match(rollback,/DROP POLICY IF EXISTS rc_code_relay_read ON realtime\.messages;/);
  assert.match(rollback,/DROP POLICY IF EXISTS rc_code_relay_write ON realtime\.messages;/);
  assert.match(rollback,/ALTER POLICY rc_code_relay_read_scope ON realtime\.messages USING \(false\);/);
  assert.match(rollback,/ALTER POLICY rc_code_relay_write_scope ON realtime\.messages WITH CHECK \(false\);/);
  assert.doesNotMatch(rollback,/DROP POLICY[^;]*_scope|DISABLE ROW LEVEL SECURITY/);
});

test('deployment allows Supabase WSS only, not provider scripts/CDNs/REST or a new serverless route',()=>{
  const csp=vercel.headers.find(item=>item.source==='/(.*)').headers.find(item=>item.key==='Content-Security-Policy').value;
  const connect=csp.split(';').find(directive=>directive.trim().startsWith('connect-src'));
  assert.ok(connect.includes('wss://*.supabase.co'));
  assert.equal(csp.split(';').find(directive=>directive.trim().startsWith('script-src')).includes('supabase'),false);
  assert.equal(connect.includes('https://*.supabase.co'),false,'transport never uses provider REST fallback');
});

test('#462 awareness needs no SQL change: policies are topic-scoped, event-agnostic and still deny Supabase Presence',()=>{
  // The y-awareness broadcast event is authorized by the same topic/expiry
  // predicates as y-update; realtime.messages.event is never consulted.
  for(const name of ['rc_code_relay_read','rc_code_relay_write','rc_code_relay_read_scope','rc_code_relay_write_scope']){
    const value=policy(name);
    assert.doesNotMatch(value,/\bevent\b|y-update|y-awareness/,name);
    // Supabase Presence uses extension 'presence': every policy requires broadcast.
    assert.match(value,/extension = 'broadcast'/,name);
  }
  assert.doesNotMatch(rollback,/\bevent\b|presence/);
});

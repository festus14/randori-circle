import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  consumeRelayTokenBudget, mintRelayToken, parseRelayTokenRequest, readRelayAuthorization,
  realtimeRelayConfiguration, relayTopic, RELAY_TOKEN_LIMIT, RELAY_TOKEN_TTL_SECONDS,
} from '../../api/_realtime-relay.js';
import { relayKeyFixture, RELAY_BODY, RELAY_IDENTITY, RELAY_PAIR } from '../support/realtime-relay.mjs';

const key=relayKeyFixture();
const config=realtimeRelayConfiguration(key.env);

test('only a literal enabled flag plus complete valid asymmetric local config advertises a relay',()=>{
  assert.ok(config); assert.equal(realtimeRelayConfiguration(key.env),config);
  for(const flag of [undefined,'false','TRUE','1',true]) assert.equal(realtimeRelayConfiguration({...key.env,REALTIME_RELAY_ENABLED:flag}),null);
  for(const field of Object.keys(key.env)) assert.equal(realtimeRelayConfiguration({...key.env,[field]:''}),null,field);
  assert.equal(realtimeRelayConfiguration({...key.env,RANDORI_LOCAL_RUNTIME:'true'}),null);
  for(const url of ['http://relay-test.supabase.co','https://elsewhere.test','https://relay-test.supabase.co/path',
    'https://user@relay-test.supabase.co','https://relay-test.supabase.co?x=1','https://relay-test.supabase.co#x','https://relay-test.supabase.co:8443']){
    assert.equal(realtimeRelayConfiguration({...key.env,SUPABASE_URL:url}),null,url);
  }
  for(const publishableKey of ['sb_secret_not_public','eyJhbGciOiJIUzI1NiJ9.legacy.service_role','sb_publishable_short','sb_publishable_abc=']){
    assert.equal(realtimeRelayConfiguration({...key.env,SUPABASE_PUBLISHABLE_KEY:publishableKey}),null);
  }
  for(const kid of ['bad kid','x'.repeat(129)]) assert.equal(realtimeRelayConfiguration({...key.env,SUPABASE_REALTIME_SIGNING_KID:kid}),null);
  for(const jwk of [null,{}, {...key.jwk,d:undefined},{...key.jwk,crv:'P-384'},{...key.jwk,kty:'RSA'},
    {...key.jwk,alg:'HS256'},{...key.jwk,use:'enc'},{...key.jwk,kid:'wrong'},
    {...key.jwk,x:'-'.repeat(43)},{...key.jwk,d:'a'}, {...key.jwk,d:relayKeyFixture().jwk.d}]){
    assert.equal(realtimeRelayConfiguration({...key.env,SUPABASE_REALTIME_SIGNING_JWK:JSON.stringify(jwk)}),null);
  }
  for(const raw of ['{bad','x'.repeat(4097)]) assert.equal(realtimeRelayConfiguration({...key.env,SUPABASE_REALTIME_SIGNING_JWK:raw}),null);
  assert.ok(realtimeRelayConfiguration({...key.env,SUPABASE_REALTIME_SIGNING_JWK:JSON.stringify({...key.jwk,alg:'ES256',use:'sig',kid:key.env.SUPABASE_REALTIME_SIGNING_KID})}));
});

test('ES256 JWT has the room/cycle/context, opaque account subject, kid and <=5-minute verified signature',()=>{
  const nowSeconds=1_800_000_000;
  const token=mintRelayToken(config,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds});
  const [header,payload,signature]=token.token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',typ:'JWT',kid:'relay-test-kid'});
  const claims=JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(claims.role,'authenticated'); assert.equal(claims.aud,'authenticated');
  assert.equal(claims.iss,'https://relay-test.supabase.co/auth/v1');
  assert.equal(claims.iat,nowSeconds); assert.equal(claims.exp-nowSeconds,RELAY_TOKEN_TTL_SECONDS);
  assert.equal(claims.room,token.topic); assert.equal(claims.room_id,RELAY_IDENTITY.roomId); assert.equal(claims.cycle,10);
  assert.deepEqual(claims.context,{question_slug:'focus-block-rollup',question_version:1,language:'javascript'});
  assert.match(claims.sub,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(Buffer.from(signature,'base64url').length,64,'JOSE raw r||s, not DER');
  const publicKey=createPublicKey({key:{...key.publicKey.export({format:'jwk'})},format:'jwk'});
  assert.ok(verify('sha256',Buffer.from(`${header}.${payload}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  assert.equal(verify('sha256',Buffer.from(`${header}.${payload}tampered`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),false);
  const second=JSON.parse(Buffer.from(mintRelayToken(config,{viewerId:2,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds}).token.split('.')[1],'base64url'));
  assert.notEqual(claims.sub,second.sub); assert.equal(claims.room,second.room);
  const again=JSON.parse(Buffer.from(mintRelayToken(config,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds:nowSeconds+1}).token.split('.')[1],'base64url'));
  assert.equal(claims.sub,again.sub);
  assert.equal(JSON.stringify(claims).includes('email'),false);
  assert.equal(Object.hasOwn(token,'privateKey'),false);
  assert.equal(mintRelayToken(config,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds,sessionExpiresAt:nowSeconds+60}).expires_at,nowSeconds+60);
  assert.throws(()=>mintRelayToken(config,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds,sessionExpiresAt:nowSeconds}),/expired/);
  for(const viewerId of [null,0,-1,1.5]) assert.throws(()=>mintRelayToken(config,{viewerId,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds}),/identity/);
  assert.throws(()=>mintRelayToken(config,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,nowSeconds:0}),/identity/);
});

test('app-derived HMAC purposes are separated from signing and survive provider-key rotation',async()=>{
  const next=relayKeyFixture();
  const rotated=realtimeRelayConfiguration({...key.env,SUPABASE_REALTIME_SIGNING_JWK:next.env.SUPABASE_REALTIME_SIGNING_JWK,
    SUPABASE_REALTIME_SIGNING_KID:'rotated-test-kid'});
  assert.ok(rotated);
  assert.notDeepEqual(config.subjectKey,Buffer.from(key.jwk.d,'base64url'));
  assert.notDeepEqual(config.rateKey,config.subjectKey);
  assert.deepEqual(rotated.subjectKey,config.subjectKey); assert.deepEqual(rotated.rateKey,config.rateKey);
  const claims=value=>JSON.parse(Buffer.from(mintRelayToken(value,{viewerId:1,identity:RELAY_IDENTITY,pair:RELAY_PAIR,
    nowSeconds:1_800_000_000}).token.split('.')[1],'base64url'));
  assert.equal(claims(rotated).sub,claims(config).sub);
  const bucketKeys=[];
  const db={execute:async statement=>{ bucketKeys.push(statement.args[0]); return {rows:[{attempts:1,expires_at:1_800_000_300}]}; }};
  await consumeRelayTokenBudget(db,config,1,1_800_000_000); await consumeRelayTokenBudget(db,rotated,1,1_800_000_000);
  assert.equal(bucketKeys[0],bucketKeys[1]);
  const appRotated=realtimeRelayConfiguration({...key.env,JWT_SECRET:'different-app-secret-at-least-thirty-two-bytes'});
  assert.notEqual(claims(appRotated).sub,claims(config).sub,'app-secret rotation explicitly changes subject pseudonyms');
  await consumeRelayTokenBudget(db,appRotated,1,1_800_000_000); assert.notEqual(bucketKeys[2],bucketKeys[0]);
  assert.equal(realtimeRelayConfiguration({...key.env,JWT_SECRET:'short'}),null);
});

test('relay topics isolate room, cycle, live pairing snapshot, question version and language',()=>{
  const original=relayTopic(RELAY_IDENTITY,RELAY_PAIR);
  assert.match(original,/^rc-code:v1:week_10_pair_20:[a-f0-9]{64}$/);
  for(const changes of [{roomId:'week_11_pair_21',weekId:11,pairGroupId:21},{questionSlug:'other'},
    {questionVersion:2},{language:'python'}]) assert.notEqual(relayTopic({...RELAY_IDENTITY,...changes},RELAY_PAIR),original);
  assert.notEqual(relayTopic(RELAY_IDENTITY,{userAId:1,userBId:3}),original);
});

test('token requests accept only a canonical primary room and exact active catalog identity',()=>{
  assert.deepEqual(parseRelayTokenRequest(RELAY_BODY),{...RELAY_IDENTITY,afterRevision:0});
  for(const body of [null,[],{}, {...RELAY_BODY,extra:'value'},{...RELAY_BODY,room_id:'week_10_pair_020'},
    {...RELAY_BODY,room_id:'circle_1_publication_1_group_1'}, {...RELAY_BODY,room_id:['week_10_pair_20']},
    {...RELAY_BODY,question_slug:'hidden-unlisted'}, {...RELAY_BODY,question_version:0}, {...RELAY_BODY,language:'bash'}]){
    assert.equal(parseRelayTokenRequest(body),null);
  }
});

test('authorization projects no ambiguous or malformed database snapshot',async()=>{
  const row={week_id:10,pair_group_id:20,user_a_id:1,user_b_id:2};
  const request={viewerId:1,...RELAY_IDENTITY};
  const db=rows=>({execute:async()=>({rows})});
  assert.deepEqual(await readRelayAuthorization(db([row]),request),RELAY_PAIR);
  for(const rows of [[],[row,row],[{...row,week_id:11}],[{...row,pair_group_id:21}],
    [{...row,user_b_id:1}],[{...row,user_b_id:0}],[{...row,user_a_id:3,user_b_id:4}]]){
    assert.equal(await readRelayAuthorization(db(rows),request),null);
  }
});

test('distributed token budget fails closed on invalid counters and respects its fixed limit',async()=>{
  const now=1_800_000_000;
  let statement;
  const db={execute:async input=>{ statement=input; return {rows:[{attempts:RELAY_TOKEN_LIMIT,expires_at:now+300}]}; }};
  assert.deepEqual(await consumeRelayTokenBudget(db,config,1,now),{ok:true,retryAfter:300});
  assert.match(statement.args[0],/^[a-f0-9]{64}$/); assert.ok(!statement.args.includes('1'));
  assert.deepEqual(await consumeRelayTokenBudget({execute:async()=>({rows:[{attempts:RELAY_TOKEN_LIMIT+1,expires_at:now+42}]})},config,1,now),{ok:false,retryAfter:42});
  for(const row of [undefined,{attempts:0,expires_at:now+300},{attempts:1.5,expires_at:now+300},
    {attempts:1,expires_at:now},{attempts:1,expires_at:'bad'}]){
    await assert.rejects(()=>consumeRelayTokenBudget({execute:async()=>({rows:[row]})},config,1,now),/unavailable/);
  }
});

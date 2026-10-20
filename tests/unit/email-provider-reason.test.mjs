import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeEmailProviderError,
  EMAIL_PROVIDER_REASON_CODES,
  emailProviderReason,
  emailProviderReasonCode,
  parseEmailProviderReason,
} from '../../api/_email-provider-reason.js';

// Real Resend phrasing (addresses replaced with reserved test domains).
const KNOWN=[
  ['You can only send testing emails to your own email address (owner@example.test). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.','testing_recipient_restricted'],
  ['The example.test domain is not verified. Please, add and verify your domain on https://resend.com/domains','domain_not_verified'],
  ['Domain has not been verified for sender noreply@example.test','domain_not_verified'],
  ['Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.','invalid_from_address'],
  ['Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.','invalid_recipient'],
  ['Invalid `reply_to` field.','invalid_recipient'],
  ['API key is invalid','api_key_invalid'],
  ['Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY','api_key_missing'],
  ['This API key is restricted to only send emails','api_key_restricted'],
  ['You have reached your daily email sending quota.','quota_exceeded'],
  ['Too many requests. You can only make 2 requests per second.','rate_limited'],
  ['Same idempotency key used with a different request payload.','idempotency_conflict'],
  ['The `to` field is missing.','missing_required_field'],
  ['Missing `subject` field.','missing_required_field'],
];

test('each known Resend phrase maps to its allowlisted reason code',()=>{
  for(const [message,reason] of KNOWN){
    assert.equal(emailProviderReasonCode(message),reason,message);
    assert.ok(EMAIL_PROVIDER_REASON_CODES.includes(reason));
  }
  assert.deepEqual(new Set(KNOWN.map(([,reason])=>reason)),
    new Set(EMAIL_PROVIDER_REASON_CODES.filter(reason=>reason!=='other')),'every reason code has a phrase');
});

test('unknown, empty, and non-string messages map to other',()=>{
  for(const message of ['A brand new provider failure for person@example.test','',undefined,null,42,{}]){
    assert.equal(emailProviderReasonCode(message),'other',String(message));
  }
  // Phrases beyond the bounded scan window are not matched.
  assert.equal(emailProviderReasonCode(`${'x'.repeat(600)} domain is not verified`),'other');
});

test('a provider error is described by status, allowlisted name and reason, never the message',()=>{
  const error={statusCode:403,name:'validation_error',message:KNOWN[0][0]};
  const described=describeEmailProviderError(error);
  assert.deepEqual({...described},{status:403,name:'validation_error',reason:'testing_recipient_restricted',
    code:'403:validation_error:testing_recipient_restricted'});
  assert.ok(Object.isFrozen(described));
  assert.equal(emailProviderReason(error),described.code);
  assert.doesNotMatch(JSON.stringify(described),/@|example\.test|resend\.com/);

  // Nested shapes, Resend's mixed-case name, and unknown names.
  assert.equal(emailProviderReason({error:{statusCode:403,name:'invalid_api_Key',message:'API key is invalid'}}),
    '403:invalid_api_key:api_key_invalid');
  assert.equal(emailProviderReason({response:{status:429}}),'429:other:other');
  assert.equal(emailProviderReason({status:500,name:'person@example.test',message:'boom'}),'500:other:other');
  assert.equal(emailProviderReason(Object.assign(new Error('provider'),{statusCode:422})),'422:other:other');

  // Not an HTTP provider error: nothing is recorded.
  for(const value of [null,undefined,'403',new Error('socket hang up'),{statusCode:200},{statusCode:302},
    {statusCode:600},{statusCode:'abc'}]){
    assert.equal(describeEmailProviderError(value),null,String(value));
    assert.equal(emailProviderReason(value),null);
  }
});

test('no address or raw message text can leak through the reason code',()=>{
  const leaks=['victim@example.test','<script>','resend.com','secret-token-123'];
  for(const [message] of KNOWN){
    for(const leak of leaks){
      const code=emailProviderReason({statusCode:403,name:leak,message:`${message} ${leak}`});
      assert.match(code,/^\d{3}:[a-z_]+:[a-z_]+$/u);
      assert.ok(code.length<=64);
      assert.equal(code.includes(leak),false,code);
    }
  }
});

test('stored reason codes parse only when well formed and allowlisted',()=>{
  assert.deepEqual({...parseEmailProviderReason('403:validation_error:domain_not_verified')},
    {status:403,name:'validation_error',reason:'domain_not_verified',code:'403:validation_error:domain_not_verified'});
  assert.equal(parseEmailProviderReason('403:made_up_name:other').code,'403:other:other');
  for(const value of ['PROVIDER_REJECTED','403:validation_error:unknown_reason','403:validation_error',
    '999:other:other','owner@example.test',null,undefined]){
    assert.equal(parseEmailProviderReason(value),null,String(value));
  }
});

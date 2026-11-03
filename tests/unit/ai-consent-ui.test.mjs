import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {COPY,confirmationText,partnerState,aiErrorText} from '../../assets/ai-consent.js';

test('per-analysis disclosure counts the payload and identifies providers and excluded data',()=>{
  assert.equal(confirmationText({transcript:'session notes'},3),"Send this session's notes (13 characters), code (3 snapshots + latest code) and interviewer questions to Groq / OpenAI for feedback?");
  assert.equal(partnerState(0),'Your partner has allowed AI feedback.');
  assert.equal(partnerState(1),'Waiting for 1 participant to allow AI feedback…');
  assert.equal(partnerState(2),'Waiting for 2 participants to allow AI feedback…');
  assert.match(COPY.personal,/name or email, or your chat messages or whiteboard/);
  assert.match(COPY.personal,/notes, code and feedback will be kept while your account exists/);
  assert.match(COPY.excluded,/OpenAI is a backup to Groq/);
});

test('consent error mapping distinguishes pending, unavailable, membership, quota and in-flight withdrawal',()=>{
  assert.match(aiErrorText(403,{error:'AI consent required from every room participant',pending_participant_count:2}),/^Waiting for 2 participants.*Nothing was sent/);
  assert.match(aiErrorText(403,{error:'AI consent required from every room participant',processing_started:true}),/No new feedback was saved/);
  assert.equal(aiErrorText(503),COPY.unavailable);
  assert.match(aiErrorText(403,{error:'trusted room membership required'}),/not available for this room/);
  assert.match(aiErrorText(429),/limit/);
  assert.match(aiErrorText(401),/Sign in/);
  assert.match(aiErrorText(403,{error:'explicit AI processing consent required'}),/not available right now/);
});

test('there is one shipped analyze transport and the visibility toggle never calls consent',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const feedback=readFileSync(new URL('../../assets/ai-feedback.js',import.meta.url),'utf8');
  const layout=readFileSync(new URL('../../assets/room-layout.js',import.meta.url),'utf8');
  assert.equal(html.includes('/api/ai/analyze'),false);
  assert.equal(feedback.split("fetch('/api/ai/analyze'").length-1,1);
  assert.match(feedback,/await consent\.prepare/);
  assert.equal(layout.includes('/api/ai/consent'),false);
  assert.match(html,/does not allow AI processing or withdraw consent/);
});

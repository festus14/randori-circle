import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const authority = html.match(/\/\/ Server-authoritative first-run progress\.([\s\S]*?)<\/script>/)?.[1] || '';
const profileJourney = html.match(/\/\/ --- New User Journey:([\s\S]*?)\/\/ Dashboard/)?.[1] || '';

test('onboarding progress reads existing authenticated authorities and not browser completion flags', () => {
  assert.match(authority, /api\('\/api\/profile'/);
  assert.match(authority, /window\._randori_availability\?\.refresh\?\.\(\)/);
  assert.match(authority, /function observePairing\(payload,operation,publicationState\)/);
  assert.doesNotMatch(authority, /api\('\/api\/settings\/availability'/);
  assert.doesNotMatch(authority, /api\('\/api\/my-pair'/);
  assert.match(authority, /value\?\.source==='user'/);
  assert.match(authority, /workspace\?\.hydrated===true/);
  assert.match(authority, /workspace\.room===pair\.roomId/);
  assert.doesNotMatch(authority, /localStorage|sessionStorage|randori-last-room|WEEKS_KEY/);
});

test('onboarding responses are fenced to request, account, circle, and target cycle', () => {
  assert.match(authority, /requestEpoch!==state\.epoch/);
  assert.match(authority, /actorId\(\)!==scope\.userId/);
  assert.match(authority, /matchesPairing\?\.\(scope\.operation,response\)===true/);
  assert.match(authority, /availability\.cycleKey===scope\.targetCycleKey/);
  assert.match(authority, /availability\.cycle\.startsAt\)===scope\.targetCycleStartsAt/);
  assert.match(authority, /state\.scope\?\.targetCycleKey/);
  assert.match(authority, /state\.controller\?\.abort\(\)/);
  assert.match(authority, /validCycle\(value\.cycle,'upcoming'\)/);
  assert.match(authority, /validCycle\(cycle,'current',observedAt\)/);
  assert.match(authority, /publicationState\?\.observed_at/);
  assert.match(html, /observePairing\?\.\(j,circleOperation,publicationState\)/);
});

test('profile authority stays account and circle scoped without depending on weekly availability', () => {
  assert.match(authority, /async function captureProfileScope\(\)/);
  assert.match(authority, /function matchesProfileScope\(scope\)/);
  assert.match(authority, /matchesCircleScope\(scope\)/);
  assert.match(authority, /async function refreshProfile\(/);
  assert.match(authority, /const responsePromise=Promise\.allSettled/);
  assert.match(profileJourney, /authority\.refreshProfile\(\{reason:'profile'\}\)/);
  assert.match(profileJourney, /captureProfileScope\?\.\(\)/);
  assert.match(profileJourney, /matchesProfileScope\?\.\(scope\)===true/);
  assert.match(profileJourney, /randori:onboarding-authority-ready/);
  assert.match(profileJourney, /await onboardingAuthorityReady/);
  assert.match(profileJourney, /removeEventListener\('randori:onboarding-authority-ready'/);
  assert.match(authority, /dispatchEvent\(new CustomEvent\('randori:onboarding-authority-ready'\)\)/);
});

test('profile loading and saving expose inline live status and retry without alerts', () => {
  assert.match(html, /id="psSaveStatus"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="psRetry"[^>]+hidden>Retry profile</);
  assert.match(profileJourney, /setProfileSaveState\('loading','Loading your saved profile/);
  assert.match(profileJourney, /setProfileSaveState\('saving','Saving your profile/);
  assert.match(profileJourney, /setProfileSaveState\('saved','Profile saved\.'/);
  assert.match(profileJourney, /setProfileSaveState\('save_error'/);
  assert.doesNotMatch(profileJourney, /\balert\s*\(/);
});

test('onboarding does not advertise AI or video without a readiness contract', () => {
  const steps = html.match(/<section id="view-profile-setup"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(steps.length > 0);
  assert.doesNotMatch(steps, /\bAI\b|Groq|video/i);
  assert.match(html, /id="chkRoom"[^>]*>[\s\S]*?Open your current workspace/);
  assert.match(authority, /workspaceAvailable=payload\.workspace_available!==false/);
});

test('the dashboard pairing observation is replayed instead of dropped while the cycle scope settles', () => {
  assert.match(authority, /lastPairing:null/);
  assert.match(authority, /if\(!state\.scope\?\.targetCycleKey\) return false;/);
  assert.match(authority, /if\(state\.pairing\.status!=='ready'&&state\.lastPairing\) applyPairing\(state\.lastPairing\);/);
  assert.match(authority, /observation\.revalidated=true;/);
  // The WP-H CSS workaround that hid the contradiction is gone.
  assert.doesNotMatch(html, /#onboardChecklist\[data-state="error"\]:not/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../assets/circle-ui.js');
const ui = globalThis.RandoriCircleUI;

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ID_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID_C = '16fd2706-8baf-433b-82eb-8c7fada847da';
const iso = offset => new Date(NOW + offset).toISOString();
const DAY = 24 * 60 * 60 * 1000;

class FakeNode {
  constructor(tag, ns = null) {
    this.tagName = tag; this.namespaceURI = ns; this.children = []; this.attributes = {};
    this.style = {}; this.className = ''; this.textContent = '';
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
}
const fakeDoc = {
  createElement: tag => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag, ns),
};

test('loads as a classic script global with a frozen API', () => {
  assert.ok(ui);
  assert.ok(Object.isFrozen(ui));
  assert.equal(typeof ui.describeInvitation, 'function');
});

test('parseInstant accepts ISO and SQLite UTC timestamps and rejects junk', () => {
  assert.equal(ui.parseInstant('2026-10-19T12:00:00.000Z'), NOW);
  assert.equal(ui.parseInstant('2026-10-19 12:00:00'), NOW);
  assert.equal(ui.parseInstant('2026-10-19T14:00:00+02:00'), NOW);
  assert.equal(ui.parseInstant('2026-10-19'), Date.parse('2026-10-19'));
  for (const bad of [null, 42, '', 'yesterday', '2026-13-45T99:99:99Z', 'x'.repeat(41), '2026-10-19T12:00:00.000Zjunk']) {
    assert.equal(ui.parseInstant(bad), null, String(bad));
  }
});

test('relativeTime picks sensible units and handles invalid input', () => {
  assert.equal(ui.relativeTime(iso(-10 * 1000), NOW, 'en'), 'just now');
  assert.equal(ui.relativeTime(iso(-5 * 60 * 1000), NOW, 'en'), '5 minutes ago');
  assert.equal(ui.relativeTime(iso(3 * 60 * 60 * 1000), NOW, 'en'), 'in 3 hours');
  assert.equal(ui.relativeTime(iso(-DAY), NOW, 'en'), 'yesterday');
  assert.equal(ui.relativeTime(iso(6 * DAY), NOW, 'en'), 'in 6 days');
  assert.equal(ui.relativeTime(iso(-60 * DAY), NOW, 'en'), '2 months ago');
  assert.equal(ui.relativeTime(iso(-800 * DAY), NOW, 'en'), '2 years ago');
  assert.equal(ui.relativeTime(NOW + 2 * DAY, NOW, 'en'), 'in 2 days');
  assert.equal(ui.relativeTime('nope', NOW), null);
  assert.equal(ui.relativeTime(iso(0), Number.NaN), null);
});

test('relativeTime falls back to English when Intl.RelativeTimeFormat is missing or throws', () => {
  const original = Intl.RelativeTimeFormat;
  try {
    Intl.RelativeTimeFormat = undefined;
    assert.equal(ui.relativeTime(iso(-3 * DAY), NOW), '3 days ago');
    assert.equal(ui.relativeTime(iso(60 * 60 * 1000), NOW), 'in 1 hour');
    Intl.RelativeTimeFormat = function Broken() { throw new RangeError('bad locale'); };
    assert.equal(ui.relativeTime(iso(2 * DAY), NOW), 'in 2 days');
  } finally {
    Intl.RelativeTimeFormat = original;
  }
});

test('absoluteDate formats a medium date and falls back to ISO dates', () => {
  assert.equal(ui.absoluteDate(iso(0), 'en-US'), 'Oct 19, 2026');
  assert.equal(ui.absoluteDate(NOW, 'en-US'), 'Oct 19, 2026');
  assert.equal(ui.absoluteDate('nope'), null);
  const original = Intl.DateTimeFormat;
  try {
    Intl.DateTimeFormat = function Broken() { throw new RangeError('bad'); };
    assert.equal(ui.absoluteDate(iso(0)), '2026-10-19');
  } finally {
    Intl.DateTimeFormat = original;
  }
});

test('invitation statuses map to friendly labels and tones', () => {
  assert.deepEqual({ ...ui.invitationStatus('pending') }, { key: 'pending', label: 'Pending', tone: 'info' });
  assert.equal(ui.invitationStatus('used').label, 'Accepted');
  assert.equal(ui.invitationStatus('accepted').key, 'accepted');
  assert.equal(ui.invitationStatus('expired').tone, 'warning');
  assert.equal(ui.invitationStatus('revoked').label, 'Revoked');
  assert.equal(ui.invitationStatus('weird').key, 'pending');
  assert.equal(ui.invitationStatus(undefined).key, 'pending');
});

test('describeInvitation never exposes fingerprints and explains each lifecycle state', () => {
  const pending = ui.describeInvitation({
    id: ID_A.toUpperCase(), status: 'pending', email_fingerprint: 'f96d3d61dcbb',
    created_at: iso(-2 * DAY), expires_at: iso(5 * DAY),
  }, { now: NOW, locale: 'en' });
  assert.equal(pending.id, ID_A);
  assert.equal(pending.title, 'Private invitation');
  assert.equal(pending.emailKnown, false);
  assert.equal(pending.detail, 'Sent 2 days ago · expires in 5 days');
  assert.ok(!JSON.stringify(pending).includes('f96d3d61dcbb'));
  assert.equal(pending.canResend, true);
  assert.equal(pending.canRevoke, true);
  assert.equal(pending.active, true);
  assert.ok(pending.expiresTitle);

  const known = ui.describeInvitation({ id: ID_A, status: 'pending', created_at: iso(0), expires_at: iso(7 * DAY) },
    { now: NOW, knownEmail: '  ada@example.com ', locale: 'en' });
  assert.equal(known.title, 'ada@example.com');
  assert.equal(known.emailKnown, true);
  assert.equal(known.detail, 'Sent just now · expires in 7 days');

  const expired = ui.describeInvitation({ id: ID_B, status: 'expired', created_at: iso(-9 * DAY), expires_at: iso(-2 * DAY) },
    { now: NOW, locale: 'en-US' });
  assert.equal(expired.label, 'Expired');
  assert.equal(expired.detail, 'Sent Oct 10, 2026 · expired 2 days ago');
  assert.equal(expired.canResend, false);

  const accepted = ui.describeInvitation({ id: ID_C, status: 'used', created_at: iso(-3 * DAY) }, { now: NOW, locale: 'en-US' });
  assert.equal(accepted.label, 'Accepted');
  assert.equal(accepted.detail, 'Sent Oct 16, 2026 · joined the circle');
  assert.equal(accepted.expiresTitle, null);

  const revoked = ui.describeInvitation({ id: ID_C, status: 'revoked' }, { now: NOW });
  assert.equal(revoked.detail, 'link no longer works');
  assert.equal(revoked.active, false);

  const pendingNoDates = ui.describeInvitation({ id: ID_C, status: 'pending' }, { now: NOW });
  assert.equal(pendingNoDates.detail, '');
  const expiredNoDates = ui.describeInvitation({ id: ID_C, status: 'expired' });
  assert.equal(expiredNoDates.detail, '');

  assert.equal(ui.describeInvitation({ id: 'f96d3d61dcbb', status: 'pending' }), null);
  assert.equal(ui.describeInvitation(null), null);
  assert.equal(ui.describeInvitation({ id: ID_A }, { knownEmail: 'x'.repeat(300) }).title, 'Private invitation');
});

test('partitionInvitations and invitationSummary separate pending from earlier invitations', () => {
  const list = [
    { id: ID_A, status: 'pending' }, { id: ID_B, status: 'revoked' }, { id: ID_C, status: 'used' },
  ];
  const { active, past } = ui.partitionInvitations(list);
  assert.deepEqual(active.map(item => item.id), [ID_A]);
  assert.deepEqual(past.map(item => item.id), [ID_B, ID_C]);
  assert.deepEqual(ui.partitionInvitations(null), { active: [], past: [] });
  assert.equal(ui.invitationSummary([]), 'No invitations yet.');
  assert.equal(ui.invitationSummary([{ status: 'pending' }]), '1 pending invitation.');
  assert.equal(ui.invitationSummary(list), '1 pending invitation, 2 earlier.');
  assert.equal(ui.invitationSummary([{ status: 'expired' }]), '0 pending invitations, 1 earlier.');
});

test('initials and focus labels', () => {
  assert.equal(ui.initials('Ada Lovelace'), 'AL');
  assert.equal(ui.initials('festus'), 'FE');
  assert.equal(ui.initials('  '), '?');
  assert.equal(ui.initials(null), '?');
  assert.equal(ui.initials('Émile zola'), 'ÉZ');
  assert.equal(ui.focusLabel('dsa'), 'DSA');
  assert.equal(ui.focusLabel('System_Design'), 'System design');
  assert.equal(ui.focusLabel('both'), 'DSA and system design');
  assert.equal(ui.focusLabel('other'), null);
  assert.equal(ui.focusLabel(undefined), null);
});

test('memberView exposes role, status and the allowed owner actions', () => {
  const member = ui.memberView({ id: 2, role: 'member', status: 'active', display_name: 'Circle Member', joined_at: '2026-10-12 12:00:00' },
    { actorId: 1, now: NOW, locale: 'en' });
  assert.equal(member.roleLabel, 'Member');
  assert.equal(member.statusLabel, 'Active');
  assert.equal(member.statusTone, 'success');
  assert.equal(member.initials, 'CM');
  assert.equal(member.joined, 'Joined 7 days ago');
  assert.deepEqual(member.actions, ['transfer', 'deactivate']);
  assert.equal(member.isSelf, false);

  const owner = ui.memberView({ id: 3, role: 'owner', status: 'active', display_name: 'Other Owner' }, { actorId: 1 });
  assert.deepEqual(owner.actions, ['deactivate']);
  assert.equal(owner.joined, null);
  assert.equal(owner.roleLabel, 'Owner');

  const inactive = ui.memberView({ id: 4, role: 'member', status: 'inactive', display_name: '' }, { actorId: 1 });
  assert.equal(inactive.name, 'Member');
  assert.equal(inactive.statusLabel, 'Inactive');
  assert.equal(inactive.statusTone, 'warning');
  assert.deepEqual(inactive.actions, ['reactivate']);

  const self = ui.memberView({ id: 1, role: 'owner', status: 'active', display_name: 'Me' }, { actorId: 1 });
  assert.equal(self.isSelf, true);
  assert.deepEqual(self.actions, []);

  assert.equal(ui.memberView({ id: 0, role: 'member', status: 'active' }), null);
  assert.equal(ui.memberView({ id: 5, role: 'admin', status: 'active' }), null);
  assert.equal(ui.memberView({ id: 5, role: 'member', status: 'gone' }), null);
  assert.equal(ui.memberView(null), null);
  assert.equal(ui.memberView({ id: 6, role: 'member', status: 'active' }).isSelf, false);
});

test('rosterPersonView marks the viewer and shows the practice focus without availability', () => {
  const view = ui.rosterPersonView({ id: 7, display_name: 'Team Mate', interview_focus: 'dsa', is_available: false }, { actorId: 7 });
  assert.deepEqual({ ...view }, { name: 'Team Mate', initials: 'TM', isSelf: true, focus: 'DSA' });
  assert.equal(ui.rosterPersonView({ name: 'Legacy' }).name, 'Legacy');
  assert.equal(ui.rosterPersonView({}).name, 'Member');
  assert.equal(ui.rosterPersonView({ id: 'x', display_name: 'A' }, { actorId: 1 }).isSelf, false);
  assert.ok(!JSON.stringify(view).match(/available|away/i));
});

test('the invite requests panel is gated on capability, owner role and primary circle', () => {
  const caps = { inviteRequests: true };
  assert.equal(ui.inviteRequestsVisible({ capabilities: caps, role: 'owner' }), true);
  assert.equal(ui.inviteRequestsVisible({ capabilities: caps, role: 'member' }), false);
  assert.equal(ui.inviteRequestsVisible({ capabilities: {}, role: 'owner' }), false);
  assert.equal(ui.inviteRequestsVisible(), false);
  const multi = { inviteRequests: true, multiCircleControlPlane: true };
  assert.equal(ui.inviteRequestsVisible({ capabilities: multi, role: 'owner', activeCircle: { is_primary: true } }), true);
  assert.equal(ui.inviteRequestsVisible({ capabilities: multi, role: 'owner', activeCircle: { is_primary: false } }), false);
  assert.equal(ui.inviteRequestsVisible({ capabilities: multi, role: 'owner' }), false);
});

const request = (overrides = {}) => ({
  id: ID_A, name: 'Ada Lovelace', email: 'ada@example.com', note: 'System design loops',
  created_at: iso(-2 * DAY), expires_at: iso(28 * DAY), ...overrides,
});

test('normalizeInviteRequest validates every field and keeps text as text', () => {
  const normalized = ui.normalizeInviteRequest(request({ note: '  <img src=x onerror=1>\nline two  ' }));
  assert.equal(normalized.id, ID_A);
  assert.equal(normalized.note, '<img src=x onerror=1>\nline two');
  assert.equal(normalized.createdAt, NOW - 2 * DAY);
  assert.equal(ui.normalizeInviteRequest(request({ note: null })).note, null);
  assert.equal(ui.normalizeInviteRequest(request({ note: '   ' })).note, null);
  assert.equal(ui.normalizeInviteRequest(request({ id: 'nope' })), null);
  assert.equal(ui.normalizeInviteRequest(request({ name: 'A'.repeat(61) })), null);
  assert.equal(ui.normalizeInviteRequest(request({ email: 'not-an-email' })), null);
  assert.equal(ui.normalizeInviteRequest(request({ email: `${'a'.repeat(250)}@x.io` })), null);
  assert.equal(ui.normalizeInviteRequest(request({ note: 'n'.repeat(281) })), null);
  assert.equal(ui.normalizeInviteRequest(request({ note: 7 })), null);
  assert.equal(ui.normalizeInviteRequest(request({ created_at: 'later' })), null);
  assert.equal(ui.normalizeInviteRequest(request({ expires_at: null })), null);
  assert.equal(ui.normalizeInviteRequest([]), null);
  assert.equal(ui.normalizeInviteRequest(null), null);
});

test('normalizeInviteRequestsResponse checks the envelope, dedupes and bounds the cursor', () => {
  const page = ui.normalizeInviteRequestsResponse({
    ok: true, status: 'pending', requests: [request(), request(), request({ id: ID_B, name: 'Grace Hopper' })],
    pending_count: 5, next_cursor: 'abc',
  });
  assert.equal(page.requests.length, 2);
  assert.equal(page.pendingCount, 5);
  assert.equal(page.nextCursor, 'abc');
  const short = ui.normalizeInviteRequestsResponse({ ok: true, requests: [request()], pending_count: 0 });
  assert.equal(short.pendingCount, 1);
  assert.equal(short.nextCursor, null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: [], next_cursor: null }).pendingCount, 0);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: false, requests: [] }), null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: 'x' }), null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: Array(101).fill(request()) }), null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: [], next_cursor: '' }), null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: [], next_cursor: 'x'.repeat(641) }), null);
  assert.equal(ui.normalizeInviteRequestsResponse({ ok: true, requests: [request({ id: 'bad' })] }), null);
  assert.equal(ui.normalizeInviteRequestsResponse(null), null);
});

test('inviteRequestView and count labels read naturally', () => {
  const view = ui.inviteRequestView(ui.normalizeInviteRequest(request()), { now: NOW, locale: 'en' });
  assert.equal(view.initials, 'AL');
  assert.equal(view.detail, 'Asked 2 days ago · expires in 28 days');
  assert.equal(view.email, 'ada@example.com');
  assert.ok(ui.inviteRequestView(ui.normalizeInviteRequest(request())).detail.startsWith('Asked '));
  assert.equal(ui.inviteRequestCountLabel(3), '3 waiting');
  assert.equal(ui.inviteRequestCountLabel(0), 'None waiting');
  assert.equal(ui.inviteRequestCountLabel(-1), 'None waiting');
  assert.equal(ui.inviteRequestCountLabel('2'), 'None waiting');
});

test('inviteRequestDecisionOutcome validates approve, decline and replay responses', () => {
  const req = ui.normalizeInviteRequest(request());
  const approved = ui.inviteRequestDecisionOutcome('approve', {
    ok: true, request: { id: ID_A, status: 'approved' },
    invitation: { id: ID_B, invite_url: `/invite#invite=${'a'.repeat(43)}` }, email_delivery: { queued: true },
  }, req);
  assert.equal(approved.message, 'Approved. An invitation email is on its way to ada@example.com.');
  assert.deepEqual(approved.invitation, { id: ID_B, inviteUrl: `/invite#invite=${'a'.repeat(43)}`, email: 'ada@example.com' });

  const noEmail = ui.inviteRequestDecisionOutcome('approve', {
    ok: true, request: { id: ID_A, status: 'approved' }, invitation: { id: ID_B, invite_url: 'https://evil.example/x' },
  }, req);
  assert.match(noEmail.message, /Copy the invitation link/);
  assert.equal(noEmail.invitation.inviteUrl, null);

  const replay = ui.inviteRequestDecisionOutcome('approve', {
    ok: true, replayed: true, request: { id: ID_A, status: 'approved' }, invitation: { id: ID_B },
  }, req);
  assert.equal(replay.message, "Ada Lovelace's request was already approved.");
  assert.deepEqual(replay.invitation, { id: ID_B, inviteUrl: null, email: null });
  const replayNoInvite = ui.inviteRequestDecisionOutcome('approve', { ok: true, replayed: true, request: { id: ID_A, status: 'approved' } }, req);
  assert.equal(replayNoInvite.invitation, null);

  const declined = ui.inviteRequestDecisionOutcome('decline', { ok: true, request: { id: ID_A, status: 'declined' } }, req);
  assert.equal(declined.message, "Declined Ada Lovelace's request. They are not notified.");
  assert.equal(declined.invitation, null);
  assert.match(ui.inviteRequestDecisionOutcome('decline', { ok: true, request: { id: ID_A, status: 'declined' } }, { id: ID_A }).message, /this person/);

  assert.equal(ui.inviteRequestDecisionOutcome('approve', { ok: true, request: { id: ID_A, status: 'approved' } }, req), null);
  assert.equal(ui.inviteRequestDecisionOutcome('approve', { ok: true, request: { id: ID_A, status: 'declined' } }, req), null);
  assert.equal(ui.inviteRequestDecisionOutcome('approve', { ok: true, request: { id: ID_B, status: 'approved' } }, req), null);
  assert.equal(ui.inviteRequestDecisionOutcome('maybe', { ok: true, request: { id: ID_A } }, req), null);
  assert.equal(ui.inviteRequestDecisionOutcome('approve', { ok: false }, req), null);
});

test('inviteRequestErrorMessage maps contract errors to recovery copy', () => {
  assert.match(ui.inviteRequestErrorMessage({ http_status: 409, code: 'invite_request_email_invalid' }),
    /can’t receive an invitation\. Decline it instead\./);
  assert.equal(ui.inviteRequestErrorMessage({ http_status: 409, code: 'invite_request_not_pending', status: 'approved' }),
    'This request was already handled. It was approved. The list has been refreshed.');
  assert.equal(ui.inviteRequestErrorMessage({ code: 'invite_request_not_pending', status: 'weird' }),
    'This request was already handled. The list has been refreshed.');
  assert.match(ui.inviteRequestErrorMessage({ http_status: 404 }), /no longer available/);
  assert.match(ui.inviteRequestErrorMessage({ http_status: 403 }), /Only the owner/);
  assert.match(ui.inviteRequestErrorMessage({ http_status: 401 }), /Sign in again/);
  assert.match(ui.inviteRequestErrorMessage({ http_status: 503 }), /Nothing changed/);
  assert.match(ui.inviteRequestErrorMessage(null), /Nothing changed/);
});

test('history rows and counts read as a clean list', () => {
  const row = ui.historyRowView({ week_id: 3, pg_id: 9, partner_name: 'Grace Hopper', week_label: 'Week of Oct 12', topic: 'Graphs' });
  assert.equal(row.room, 'week_3_pair_9');
  assert.equal(row.partnerInitials, 'GH');
  assert.equal(row.meta, 'Week of Oct 12 · Graphs');
  const fallback = ui.historyRowView({ week_id: 4, pg_id: 1, is_ai: true, topic_kind: 'system_design' });
  assert.equal(fallback.partner, 'Pair member');
  assert.equal(fallback.partnerInitials, 'AI');
  assert.equal(fallback.week, 'Week 4');
  assert.equal(fallback.meta, 'Week 4 · system_design');
  assert.equal(ui.historyRowView({ week_id: 5, pg_id: 2 }).meta, 'Week 5');
  assert.equal(ui.historyRowView({ week_id: 0, pg_id: 1 }), null);
  assert.equal(ui.historyRowView({ week_id: 1, pg_id: 'x' }), null);
  assert.equal(ui.historyRowView(null), null);
  assert.equal(ui.historyCountLabel(1), '1 pairing');
  assert.equal(ui.historyCountLabel(4), '4 pairings');
  assert.equal(ui.historyCountLabel(undefined), '0 pairings');
});

test('run summaries keep the verified-run wording and humanise language and duration', () => {
  const run = ui.runSummary({ question_slug: 'focus-block-rollup', question_version: 2, language: 'python', passed_count: 8, total_count: 8, duration_ms: 1234 });
  assert.equal(run.title, 'Verified run · focus-block-rollup v2');
  assert.equal(run.meta, 'Python · 8/8 passed · 1.2 s');
  assert.equal(run.allPassed, true);
  const partial = ui.runSummary({ question_slug: 's', question_version: 1, language: 'elixir', passed_count: 1, total_count: 3, duration_ms: null });
  assert.equal(partial.meta, 'Elixir · 1/3 passed');
  assert.equal(partial.allPassed, false);
  assert.equal(ui.runSummary({ question_slug: 's', question_version: 1, language: '', passed_count: 0, total_count: 0 }).allPassed, false);
  assert.equal(ui.languageLabel(''), 'Unknown language');
  assert.equal(ui.languageLabel('CPP'), 'C++');
  assert.equal(ui.durationLabel(250), '250 ms');
  assert.equal(ui.durationLabel(12_500), '13 s');
  assert.equal(ui.durationLabel(125_000), '2 min 5 s');
  assert.equal(ui.durationLabel(-1), null);
  assert.equal(ui.durationLabel(1.5), null);
});

test('node builders create text-only, accessible nodes', () => {
  const icon = ui.iconNode(fakeDoc, 'i-mail');
  assert.equal(icon.attributes['aria-hidden'], 'true');
  assert.equal(icon.children[0].attributes.href, '/assets/brand/icons.svg#i-mail');
  assert.equal(ui.iconNode(fakeDoc, '"><script>').children[0].attributes.href, '/assets/brand/icons.svg#i-info');

  const badge = ui.badgeNode(fakeDoc, 'Pending', 'info');
  assert.equal(badge.className, 'rc-badge rc-badge--info');
  assert.equal(badge.textContent, 'Pending');
  assert.equal(ui.badgeNode(fakeDoc, 'Revoked', 'neutral').className, 'rc-badge');

  const avatar = ui.avatarNode(fakeDoc, { label: 'ALX', color: '#123456' });
  assert.equal(avatar.textContent, 'AL');
  assert.equal(avatar.style.background, '#123456');
  assert.equal(avatar.attributes['aria-hidden'], 'true');
  assert.match(avatar.className, /circle-avatar--md/);
  const neutral = ui.avatarNode(fakeDoc, { size: 'sm' });
  assert.equal(neutral.textContent, '?');
  assert.match(neutral.className, /circle-avatar--sm/);
  assert.match(neutral.className, /circle-avatar--neutral/);
  assert.match(ui.avatarNode(fakeDoc).className, /circle-avatar--md/);
});

test('index.html wires the helpers, removes jargon and keeps the test hooks', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const script = html.indexOf('<script src="/assets/circle-ui.js"></script>');
  const main = html.indexOf('// ---------- auth layer ----------');
  assert.ok(script > 0 && script < main, 'helpers load before the main script');
  assert.match(html, /<link rel="stylesheet" href="\/assets\/circle-history.css"\/>/);
  assert.doesNotMatch(html, /Server-backed pairings and saved activity/);
  assert.doesNotMatch(html, /How Randori works/);
  assert.doesNotMatch(html, /email_fingerprint/);
  for (const hook of [
    'data-testid="circle-members"', 'data-testid="circle-lifecycle"', 'data-testid="circle-manage-members"',
    'data-testid="circle-invites"', 'data-testid="circle-invite-email"', 'data-testid="circle-invite-create"',
    'data-testid="circle-invite-link"', 'data-testid="circle-archive"', 'data-testid="circle-leave"',
    'data-testid="circle-invite-requests"', 'data-testid="pair-history"', 'data-testid="pair-recap"',
    'data-testid="pair-history-list"', 'id="peopleList"', 'id="circleOwnerPanel"', 'id="circleRoleLabel"',
    'id="historyCount"', 'id="historyAuthHint"', 'id="historyList"', 'id="demoBtn"', 'id="clearAllBtn"',
  ]) assert.ok(html.includes(hook), hook);
  // Demo controls live in the admin-only Diagnostics disclosure, hidden by default.
  const diagnostics = html.slice(html.indexOf('<details id="circleDiagnostics"'), html.indexOf('</details>', html.indexOf('<details id="circleDiagnostics"')));
  assert.match(diagnostics, /hidden/);
  assert.ok(diagnostics.includes('id="demoBtn"'));
  // The invite-requests panel is appended after the owner invitation panel.
  assert.ok(html.indexOf('id="circleInviteRequestsPanel"') > html.indexOf('id="circleOwnerPanel"'));
});

test('the stylesheet uses tokens and hides the roster only while the managed list is shown', async () => {
  const css = await readFile(new URL('../../assets/circle-history.css', import.meta.url), 'utf8');
  assert.match(css, /\.circle-members-card:has\(#circleManageMembers:not\(\[hidden\]\)\[data-state="ready"\]\) #peopleList \{ display: none; \}/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no hard-coded colors');
  assert.match(css, /@media \(forced-colors: active\)/);
});

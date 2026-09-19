import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALENDAR_DURATION_MINUTES,
  buildScheduleCalendar,
  calendarTimestamp,
  calendarUid,
  downloadScheduleCalendar,
  escapeCalendarText,
  foldCalendarLine,
  normalizedCalendarInstant,
  secondaryCalendarUid,
} from '../../assets/calendar-export.js';

const roomId = 'week_42_pair_7';
const agreedTime = '2026-10-06T17:30:00.000Z';
const generatedAt = new Date('2026-09-19T10:11:12.345Z');

test('builds a private RFC 5545 event with UTC start and a fixed 60-minute end', () => {
  const calendar = buildScheduleCalendar({
    roomId,
    agreedTime,
    appOrigin: 'https://randori.example',
    generatedAt,
  });

  assert.equal(CALENDAR_DURATION_MINUTES, 60);
  assert.equal(calendar.filename, `randori-${roomId}.ics`);
  assert.equal(calendar.roomLink, `https://randori.example/join/${roomId}`);
  assert.match(calendar.content, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.doesNotMatch(calendar.content, /\r\nMETHOD:/);
  assert.match(calendar.content, /\r\nBEGIN:VEVENT\r\n/);
  assert.match(calendar.content, /\r\nDTSTAMP:20260919T101112Z\r\n/);
  assert.match(calendar.content, /\r\nDTSTART:20261006T173000Z\r\n/);
  assert.match(calendar.content, /\r\nDTEND:20261006T183000Z\r\n/);
  assert.match(calendar.content, new RegExp(`\\r\\nUID:${roomId}@calendar\\.randori-circle\\r\\n`));
  assert.match(calendar.content, new RegExp(`\\r\\nURL:https://randori\\.example/join/${roomId}\\r\\n`));
  assert.match(calendar.content, /\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n$/);

  for (const privateValue of ['partner@example.test', 'Candidate A', 'invite-token', 'console.log', 'private chat']) {
    assert.doesNotMatch(calendar.content, new RegExp(privateValue, 'i'));
  }
});

test('escapes RFC text and folds every content line to at most 75 UTF-8 octets', () => {
  assert.equal(
    escapeCalendarText('slash\\, semicolon;\r\nnext'),
    'slash\\\\\\, semicolon\\;\\nnext',
  );
  const folded = foldCalendarLine(`DESCRIPTION:${'pair practice 🥋, '.repeat(12)}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.slice(1).every(line => line.startsWith(' ')));
  assert.ok(lines.every(line => new TextEncoder().encode(line).length <= 75));
});

test('requires a normalized accepted instant, canonical room, and bare HTTP origin', () => {
  for (const invalidInstant of [
    null,
    '',
    '2026-10-06',
    '2026-10-06T18:30:00+01:00',
    '2026-02-30T17:30:00.000Z',
    'not-a-date',
  ]) {
    assert.equal(normalizedCalendarInstant(invalidInstant), null);
    assert.equal(buildScheduleCalendar({ roomId, agreedTime: invalidInstant, appOrigin: 'https://randori.example' }), null);
  }
  assert.ok(normalizedCalendarInstant('9999-12-31T23:30:00.000Z'));
  assert.equal(buildScheduleCalendar({
    roomId,
    agreedTime: '9999-12-31T23:30:00.000Z',
    appOrigin: 'https://randori.example',
  }), null, 'an end outside the four-digit RFC timestamp envelope fails closed');
  for (const invalidRoom of ['', 'week_0_pair_7', 'week_42_pair_0', '../private', 'week_42_pair_7?token=secret']) {
    assert.equal(calendarUid(invalidRoom), null);
    assert.equal(buildScheduleCalendar({ roomId: invalidRoom, agreedTime, appOrigin: 'https://randori.example' }), null);
  }
  for (const invalidOrigin of [
    '',
    'javascript:alert(1)',
    'https://user:pass@randori.example',
    'https://randori.example/path',
    'https://randori.example/',
  ]) {
    assert.equal(buildScheduleCalendar({ roomId, agreedTime, appOrigin: invalidOrigin }), null);
  }
});

test('keeps identity stable across reschedules while changing only the event time', () => {
  const first = buildScheduleCalendar({ roomId, agreedTime, appOrigin: 'https://randori.example', generatedAt });
  const rescheduled = buildScheduleCalendar({
    roomId,
    agreedTime: '2026-10-08T19:00:00.000Z',
    appOrigin: 'https://randori.example',
    generatedAt: new Date('2026-09-20T09:00:00.000Z'),
  });

  assert.equal(first.uid, rescheduled.uid);
  assert.equal(first.filename, rescheduled.filename);
  assert.match(first.content, /DTSTART:20261006T173000Z/);
  assert.match(rescheduled.content, /DTSTART:20261008T190000Z/);
  assert.doesNotMatch(rescheduled.content, /DTSTART:20261006T173000Z/);
});

test('secondary calendar identity is opaque and links only to the dashboard', () => {
  const scheduleId='a'.repeat(64);
  const calendar=buildScheduleCalendar({
    scheduleId,agreedTime,appOrigin:'https://randori.example',generatedAt,
  });
  assert.equal(secondaryCalendarUid(scheduleId),`secondary-${scheduleId}@calendar.randori-circle`);
  assert.equal(calendar.uid,`secondary-${scheduleId}@calendar.randori-circle`);
  assert.equal(calendar.roomLink,'https://randori.example/?view=dashboard');
  assert.equal(calendar.filename,`randori-${scheduleId.slice(0,16)}.ics`);
  assert.match(calendar.content,/URL:https:\/\/randori\.example\/\?view=dashboard/);
  assert.doesNotMatch(calendar.content,/\/join\/|room/i);
  assert.equal(buildScheduleCalendar({
    roomId,scheduleId,agreedTime,appOrigin:'https://randori.example',generatedAt,
  }),null,'a calendar event cannot mix room and secondary identities');
  assert.equal(buildScheduleCalendar({
    scheduleId,agreedTime,appOrigin:'https://randori.example',dashboardPath:'/join/forged',generatedAt,
  }),null);
});

test('uses absolute UTC arithmetic through daylight-saving transitions', () => {
  const spring = buildScheduleCalendar({
    roomId,
    agreedTime: '2026-03-29T00:30:00.000Z',
    appOrigin: 'http://127.0.0.1:3000',
    generatedAt,
  });
  const autumn = buildScheduleCalendar({
    roomId,
    agreedTime: '2026-10-25T00:30:00.000Z',
    appOrigin: 'http://127.0.0.1:3000',
    generatedAt,
  });

  assert.match(spring.content, /DTSTART:20260329T003000Z\r\nDTEND:20260329T013000Z/);
  assert.match(autumn.content, /DTSTART:20261025T003000Z\r\nDTEND:20261025T013000Z/);
  assert.equal(calendarTimestamp(new Date('2026-09-19T10:11:12.999Z')), '20260919T101112Z');
});

test('browser adapter downloads one calendar blob and always revokes its object URL', async () => {
  const actions = [];
  const anchor = {
    hidden: false,
    click() { actions.push('click'); },
    remove() { actions.push('remove'); },
  };
  const documentObject = {
    createElement(tag) { assert.equal(tag, 'a'); return anchor; },
    body: { appendChild(node) { assert.equal(node, anchor); actions.push('append'); } },
  };
  const urlApi = {
    createObjectURL(blob) { actions.push(blob); return 'blob:private-calendar'; },
    revokeObjectURL(value) { actions.push(`revoke:${value}`); },
  };

  assert.equal(downloadScheduleCalendar(
    { roomId, agreedTime, appOrigin: 'https://randori.example', generatedAt },
    { documentObject, urlApi, BlobConstructor: Blob, defer: callback => callback() },
  ), true);
  assert.equal(anchor.href, 'blob:private-calendar');
  assert.equal(anchor.download, `randori-${roomId}.ics`);
  assert.equal(anchor.hidden, true);
  assert.deepEqual(actions.filter(value => typeof value === 'string'), [
    'append', 'click', 'remove', 'revoke:blob:private-calendar',
  ]);
  const blob = actions.find(value => value instanceof Blob);
  assert.equal(blob.type, 'text/calendar;charset=utf-8');
  assert.match(await blob.text(), /BEGIN:VCALENDAR/);

  assert.equal(downloadScheduleCalendar(
    { roomId: 'invalid', agreedTime, appOrigin: 'https://randori.example' },
    { documentObject, urlApi, BlobConstructor: Blob, defer: callback => callback() },
  ), false);
});

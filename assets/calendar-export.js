const CANONICAL_ROOM = /^week_([1-9]\d*)_pair_([1-9]\d*)$/;
const SECONDARY_SCHEDULE_ID = /^[a-f0-9]{64}$/;
const NORMALIZED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const CALENDAR_DURATION_MINUTES = 60;

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

export function escapeCalendarText(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

export function foldCalendarLine(value) {
  const source = String(value ?? '');
  const lines = [];
  let current = '';
  let limit = 75;

  for (const character of source) {
    if (current && utf8Length(current + character) > limit) {
      lines.push(current);
      current = ` ${character}`;
      limit = 75;
    } else {
      current += character;
    }
  }
  lines.push(current);
  return lines.join('\r\n');
}

export function normalizedCalendarInstant(value) {
  if (typeof value !== 'string' || !NORMALIZED_INSTANT.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return null;
  return date;
}

export function calendarTimestamp(value) {
  const date = value instanceof Date ? value : normalizedCalendarInstant(value);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const instant = date.toISOString();
  if (!NORMALIZED_INSTANT.test(instant)) return null;
  return instant.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function calendarUid(roomId) {
  if (typeof roomId !== 'string' || !CANONICAL_ROOM.test(roomId)) return null;
  return `${roomId}@calendar.randori-circle`;
}

export function secondaryCalendarUid(scheduleId) {
  if (typeof scheduleId !== 'string' || !SECONDARY_SCHEDULE_ID.test(scheduleId)) return null;
  return `secondary-${scheduleId}@calendar.randori-circle`;
}

function canonicalOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildScheduleCalendar({
  roomId, scheduleId, dashboardPath = '/?view=dashboard', agreedTime, appOrigin,
  generatedAt = new Date(),
} = {}) {
  const secondaryUid = secondaryCalendarUid(scheduleId);
  const roomUid = calendarUid(roomId);
  if ((secondaryUid && roomUid) || (!secondaryUid && !roomUid)) return null;
  const uid = secondaryUid || roomUid;
  const start = normalizedCalendarInstant(agreedTime);
  const origin = canonicalOrigin(appOrigin);
  const stamp = calendarTimestamp(generatedAt);
  if (!uid || !start || !origin || !stamp) return null;

  const end = new Date(start.getTime() + CALENDAR_DURATION_MINUTES * 60_000);
  const startTimestamp = calendarTimestamp(start);
  const endTimestamp = calendarTimestamp(end);
  if (!startTimestamp || !endTimestamp) return null;
  if (secondaryUid && dashboardPath !== '/?view=dashboard') return null;
  const roomLink = secondaryUid
    ? `${origin}${dashboardPath}`
    : `${origin}/join/${encodeURIComponent(roomId)}`;
  const properties = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Randori Circle//Private Session Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeCalendarText(uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${startTimestamp}`,
    `DTEND:${endTimestamp}`,
    `SUMMARY:${escapeCalendarText('Randori practice session')}`,
    `DESCRIPTION:${escapeCalendarText(secondaryUid
      ? 'Open your Randori dashboard to coordinate. This 60-minute exported copy is managed by your calendar app.'
      : 'Open your private Randori room in the app. This 60-minute exported copy is managed by your calendar app.')}`,
    `URL:${roomLink}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return {
    content: `${properties.map(foldCalendarLine).join('\r\n')}\r\n`,
    filename: secondaryUid?`randori-${scheduleId.slice(0,16)}.ics`:`randori-${roomId}.ics`,
    roomLink,
    uid,
  };
}

export function downloadScheduleCalendar(options, browser = {}) {
  const calendar = buildScheduleCalendar(options);
  const documentObject = browser.documentObject ?? globalThis.document;
  const urlApi = browser.urlApi ?? globalThis.URL;
  const BlobConstructor = browser.BlobConstructor ?? globalThis.Blob;
  const defer = browser.defer ?? globalThis.setTimeout;
  if (!calendar || !documentObject || !urlApi?.createObjectURL || !BlobConstructor || !defer) return false;

  const objectUrl = urlApi.createObjectURL(new BlobConstructor([calendar.content], {
    type: 'text/calendar;charset=utf-8',
  }));
  let anchor;
  try {
    anchor = documentObject.createElement('a');
    anchor.href = objectUrl;
    anchor.download = calendar.filename;
    anchor.hidden = true;
    documentObject.body.appendChild(anchor);
    anchor.click();
    return true;
  } finally {
    anchor?.remove();
    defer(() => urlApi.revokeObjectURL(objectUrl), 0);
  }
}

if (typeof window !== 'undefined') {
  window._randori_calendar_export = Object.freeze({
    build: buildScheduleCalendar,
    download: downloadScheduleCalendar,
  });
}

// What an app_logs row may say about the client (ID-82, issue #340).
//
// app_logs used to keep the raw client IP address (first X-Forwarded-For
// entry) and the full user agent for its 30-day retention. Nothing needs
// either: rate limits keep their own keyed hashes in auth_rate_limits, and
// runner lease/quota checks read user_id. Every writer now stores:
//
//   ip  NULL on any row with a user_id: the account already says who it was.
//       On rows without one (server and cron events), 'h1:' + 16 hex
//       characters of HMAC-SHA256(LOG_ADDRESS_SECRET or JWT_SECRET,
//       'randori-log-address-v1' NUL <UTC day> NUL <network>), where the
//       network is the IPv4 address or the IPv6 /64 (clientNetwork). Rows
//       from one source on one UTC day share a value, so a burst can be
//       traced. The value is pseudonymous, not anonymous: anyone holding the
//       secret can enumerate every IPv4 address for a day (2^32 HMACs, about
//       an hour of one core), so they can reverse it and link it across days.
//       Without the secret, values can't be reversed or linked across days.
//       NULL when the address is not an IP literal or no secret is set.
//   ua  a coarse family from a fixed vocabulary, never text from the input:
//       browser and major version plus OS (and its major version where the
//       user agent has one), e.g. 'Chrome 131 on Windows 10/11',
//       'Safari 17 on iOS 17'; 'bot' for crawlers; 'other' for anything
//       unrecognised; NULL when there is no user agent.
//
// Rows written before ID-82 still hold raw values until the 30-day retention
// (ID-72) deletes them; the admin logs API reduces them the same way when it
// reads them (presentAppLogClient), so admins see only reduced values.

import { createHmac } from 'node:crypto';

import { clientNetwork } from './_client-address.js';

export const LOG_ADDRESS_HASH_PATTERN=/^h1:[0-9a-f]{16}$/;

const DAY=/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;
const UA_SCAN_MAX=512;

// A crawler names itself as a product (Googlebot/2.1, Slackbot-LinkExpanding)
// or uses the bare word; a device model that merely ends in "bot" (CUBOT X30)
// is neither.
const BOT=/\b\w*(?:bot|crawler|spider)(?:[/-]|$)|\b(?:bot|crawler|spider)\b/i;
// Checked in order: Edge, Opera and Samsung Internet also say Chrome, and
// Chrome on iOS also says Safari. A version is 1–4 digits and nothing longer.
const BROWSERS=Object.freeze([
  ['Edge',/\bEdg(?:e|A|iOS)?\/(\d{1,4})(?!\d)/],
  ['Opera',/\b(?:OPR|Opera)\/(\d{1,4})(?!\d)/],
  ['Samsung Internet',/\bSamsungBrowser\/(\d{1,4})(?!\d)/],
  ['Firefox',/\b(?:Firefox|FxiOS)\/(\d{1,4})(?!\d)/],
  ['Headless Chrome',/\bHeadlessChrome\/(\d{1,4})(?!\d)/],
  ['Chrome',/\b(?:Chrome|CriOS|Chromium)\/(\d{1,4})(?!\d)/],
  ['Safari',/\bVersion\/(\d{1,4})(?:\.\d{1,4}){0,3}(?: Mobile\/\w{1,16})? Safari\//],
]);
// Windows 11 still reports NT 10.0, and macOS freezes its version at 10_15_7,
// so neither carries a usable major version.
const WINDOWS=Object.freeze({'10.0':'Windows 10/11','6.3':'Windows 8.1','6.2':'Windows 8','6.1':'Windows 7'});
const SYSTEMS=Object.freeze([
  [/\b(?:iPhone|iPad|iPod)\b[^)]{0,80}?\bOS (\d{1,2})_/,match=>`iOS ${match[1]}`],
  [/\bAndroid (\d{1,2})(?!\d)/,match=>`Android ${match[1]}`],
  [/\bWindows NT (\d{1,2}\.\d)/,match=>WINDOWS[match[1]]||'Windows'],
  [/\bCrOS\b/,()=>'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X)\b/,()=>'macOS'],
  [/\bLinux\b/,()=>'Linux'],
]);
const FAMILY=/^(?:bot|other|(?:Edge|Opera|Samsung Internet|Firefox|Headless Chrome|Chrome|Safari|other)(?: \d{1,4})? on (?:iOS \d{1,2}|Android \d{1,2}|Windows(?: 10\/11| 8\.1| 8| 7)?|ChromeOS|macOS|Linux|other))$/;

// The salt day comes from this process's clock, while created_at comes from
// the database clock. Within a moment of UTC midnight the two can name
// different days, so a row's hash may use the neighbouring day's salt; that
// only matters to an operator checking an address, who should try both days.
function utcDay(day){
  if(day===undefined) return new Date().toISOString().slice(0,10);
  if(day instanceof Date) return Number.isNaN(day.getTime())?null:day.toISOString().slice(0,10);
  return DAY.exec(String(day??''))?.[1]??null;
}

// Read from the environment here rather than through getJwtSecret() in
// api/_db.js: that throws when the secret is missing and would pull the
// database module into every logger, and a log row must never fail because
// of its address field. LOG_ADDRESS_SECRET lets this key rotate on its own;
// the label below keeps it domain-separated when JWT_SECRET is shared.
function addressSecret(){
  return process.env.LOG_ADDRESS_SECRET||process.env.JWT_SECRET;
}

/**
 * The daily keyed hash of an IP literal for app_logs.ip, or null. `day` (a
 * Date or a 'YYYY-MM-DD…' string, default today in UTC) is the salt. Anything
 * that is not an IP literal, including an existing hash, is null: writers
 * only ever store a fresh hash of a real address.
 */
export function logAddressHash(value,{day,secret=addressSecret()}={}){
  const network=clientNetwork(value);
  const date=utcDay(day);
  if(!network||!date||typeof secret!=='string'||!secret) return null;
  const digest=createHmac('sha256',secret)
    .update(`randori-log-address-v1\0${date}\0${network}`,'utf8')
    .digest('hex');
  return `h1:${digest.slice(0,16)}`;
}

/**
 * The coarse family of a user agent for app_logs.ua, or null when there is
 * none. The result only ever contains words from the vocabulary above and a
 * 1–4 digit version; an exact family is returned unchanged.
 */
export function userAgentFamily(value){
  if(typeof value!=='string') return null;
  const text=value.trim().slice(0,UA_SCAN_MAX);
  if(!text) return null;
  if(FAMILY.test(text)) return text;
  if(BOT.test(text)) return 'bot';
  let browser=null;
  for(const [name,pattern] of BROWSERS){
    const match=pattern.exec(text);
    if(match){ browser=`${name} ${Number(match[1])}`; break; }
  }
  let system=null;
  for(const [pattern,label] of SYSTEMS){
    const match=pattern.exec(text);
    if(match){ system=label(match); break; }
  }
  if(!browser&&!system) return 'other';
  return `${browser||'other'} on ${system||'other'}`;
}

function header(headers,name){
  const value=headers?.[name];
  return Array.isArray(value)?value[0]:value;
}

function hasUser(userId){
  return userId!==undefined&&userId!==null&&userId!=='';
}

/**
 * The `ua` and `ip` values for an app_logs row written while serving a
 * request. `context` is the request itself or a logger context holding
 * `req` or `headers`; an explicit `ip`/`ua` on the context wins over the
 * headers. A row with a `userId` keeps no address at all.
 */
export function appLogClientFields(context,{userId}={}){
  try{
    const req=context?.req??context;
    const headers=context?.headers??req?.headers;
    const agent=context?.ua??header(headers,'user-agent');
    let ip=null;
    if(!hasUser(userId)){
      const forwarded=String(header(headers,'x-forwarded-for')??'').split(',')[0].trim();
      ip=logAddressHash(context?.ip??(forwarded||header(headers,'x-real-ip')||req?.socket?.remoteAddress));
    }
    return Object.freeze({ua:userAgentFamily(agent),ip});
  }catch{
    // A malformed request context never stops the log row; it just says nothing about the client.
    return Object.freeze({ua:null,ip:null});
  }
}

/**
 * The reduced `ua` and `ip` of a stored row for the admin logs API. A row
 * with a user_id shows no address. A row from before ID-82 is hashed with its
 * own created_at day, so it matches what a new row from that source on that
 * day holds; a stored hash is shown as it is.
 */
export function presentAppLogClient(row){
  let ip=null;
  if(!hasUser(row?.user_id)){
    ip=typeof row?.ip==='string'&&LOG_ADDRESS_HASH_PATTERN.test(row.ip)
      ?row.ip
      :logAddressHash(row?.ip,{day:row?.created_at??undefined});
  }
  return Object.freeze({ua:userAgentFamily(row?.ua),ip});
}

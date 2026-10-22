// What an app_logs row may say about the client (ID-82, issue #340).
//
// app_logs used to keep the raw client IP address (first X-Forwarded-For
// entry) and the full user agent for its 30-day retention. Nothing needs
// either: rate limits keep their own keyed hashes in auth_rate_limits, and
// runner lease/quota checks read user_id. Every writer now stores:
//
//   ip  'h1:' + 16 hex characters of HMAC-SHA256(JWT_SECRET,
//       'randori-log-address-v1' NUL <UTC day> NUL <network>), where the
//       network is the IPv4 address or the IPv6 /64 (clientNetwork). Rows
//       from one client on one UTC day share a value, so a burst can still be
//       traced to one source, and an operator holding the secret can check a
//       known address for a given day. The day is part of the input, so
//       values can't be linked across days. NULL when the address is not an
//       IP literal or no secret is configured.
//   ua  a coarse family from a fixed vocabulary, never text from the input:
//       browser and major version plus OS (and its major version where the
//       user agent has one), e.g. 'Chrome 131 on Windows 10/11',
//       'Safari 17 on iOS 17'; 'bot' for crawlers; 'other' for anything
//       unrecognised; NULL when there is no user agent.
//
// Rows written before ID-82 still hold raw values until the 30-day retention
// (ID-72) deletes them; the admin logs API reduces them the same way when it
// reads them, so admins see only reduced values either way.

import { createHmac } from 'node:crypto';

import { clientNetwork } from './_client-address.js';

export const LOG_ADDRESS_HASH_PATTERN=/^h1:[0-9a-f]{16}$/;

const DAY=/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;
const UA_SCAN_MAX=512;

const BOT=/(?:bot|crawler|spider)\b/i;
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

function utcDay(day){
  if(day===undefined) return new Date().toISOString().slice(0,10);
  if(day instanceof Date) return Number.isNaN(day.getTime())?null:day.toISOString().slice(0,10);
  return DAY.exec(String(day??''))?.[1]??null;
}

/**
 * The daily keyed hash of a client address for app_logs.ip, or null. `day`
 * (a Date or a 'YYYY-MM-DD…' string, default today in UTC) is the salt; an
 * existing hash is returned unchanged.
 */
export function logAddressHash(value,{day,secret=process.env.JWT_SECRET}={}){
  if(typeof value==='string'&&LOG_ADDRESS_HASH_PATTERN.test(value)) return value;
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
 * 1–4 digit version; an existing family is returned unchanged.
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

/**
 * The `ua` and `ip` values for an app_logs row written while serving a
 * request. `context` is the request itself or a logger context holding
 * `req` or `headers`; an explicit `ip`/`ua` on the context wins over the
 * headers. Both values are reduced as described above.
 */
export function appLogClientFields(context){
  try{
    const req=context?.req??context;
    const headers=context?.headers??req?.headers;
    const forwarded=String(header(headers,'x-forwarded-for')??'').split(',')[0].trim();
    const address=context?.ip??(forwarded||header(headers,'x-real-ip')||req?.socket?.remoteAddress);
    const agent=context?.ua??header(headers,'user-agent');
    return Object.freeze({
      ua:userAgentFamily(agent),
      ip:logAddressHash(address),
    });
  }catch{
    // A malformed request context never stops the log row; it just says nothing about the client.
    return Object.freeze({ua:null,ip:null});
  }
}

/**
 * The reduced `ua` and `ip` of a stored row for the admin logs API. Rows from
 * before ID-82 are hashed with their own created_at day, so they match what a
 * new row from the same client on that day would hold.
 */
export function presentAppLogClient(row){
  return Object.freeze({
    ua:userAgentFamily(row?.ua),
    ip:logAddressHash(row?.ip,{day:row?.created_at??undefined}),
  });
}

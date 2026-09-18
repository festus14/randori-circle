import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import { redactSentryText, sanitizeSentryContext, sanitizeSentryEvent } from './_sentry.js';

export const JWT_ISSUER = 'randori-circle';
export const JWT_AUDIENCE = 'randori-web';

// ---- Sentry server init (optional, DSN via env) ----
import * as Sentry from '@sentry/node';
let sentryInit = false;

export function initSentry() {
  if (sentryInit) return;
  try {
    const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
    if (!dsn) return;
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      beforeSend: sanitizeSentryEvent,
      beforeSendTransaction: sanitizeSentryEvent,
      beforeSendSpan: sanitizeSentryEvent,
    });
    sentryInit = true;
  } catch (e) {
    try { console.warn('[sentry server init fail]', e && e.message); } catch {}
  }
}
initSentry();

export function getSentry() { return { Sentry, ready: sentryInit }; }

export function captureSentryMessage(message, context = {}) {
  initSentry();
  if (!sentryInit) return null;
  try {
    return Sentry.captureMessage(
      redactSentryText(message),
      sanitizeSentryContext(context),
    );
  } catch (error) {
    try { console.warn('[sentry capture message fail]', error && error.message); } catch {}
    return null;
  }
}

export function captureSentryException(error, context = {}) {
  initSentry();
  if (!sentryInit) return null;
  try {
    return Sentry.captureException(
      error,
      sanitizeSentryContext(context),
    );
  } catch (captureError) {
    try { console.warn('[sentry capture exception fail]', captureError && captureError.message); } catch {}
    return null;
  }
}

export function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Missing TURSO_DATABASE_URL");
  return createClient({ url, authToken });
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing JWT_SECRET');
  }
  return secret;
}

export function getCronSecret() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error('Missing CRON_SECRET');
  }
  return secret;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(part.slice(idx + 1).trim()); }
    catch { cookies[key] = part.slice(idx + 1).trim(); }
  }
  return cookies;
}

export function verifyRequestAuth(req) {
  const auth = req?.headers?.authorization || req?.headers?.Authorization || '';
  const bearer = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i)?.[1] : null;
  const cookieToken = parseCookies(req?.headers?.cookie || req?.headers?.Cookie || '').randori_session;
  const token = bearer || cookieToken;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const userId = Number(payload?.id ?? payload?.uid);
    return Number.isInteger(userId) && userId > 0 ? payload : null;
  } catch {
    return null;
  }
}

export function verifyMutationOrigin(req) {
  const method=String(req?.method||'GET').toUpperCase();
  if(['GET','HEAD','OPTIONS'].includes(method)) return true;
  const auth=String(req?.headers?.authorization||req?.headers?.Authorization||'');
  if(/^Bearer\s+\S+/i.test(auth)) return true;
  const cookies=parseCookies(req?.headers?.cookie||req?.headers?.Cookie||'');
  if(!cookies.randori_session) return true;
  const origin=String(req?.headers?.origin||req?.headers?.Origin||'').trim();
  const host=String(req?.headers?.['x-forwarded-host']||req?.headers?.host||'').split(',')[0].trim();
  if(!origin || !host) return false;
  try{ return new URL(origin).host===host; }catch{ return false; }
}

export function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(list);
}

export function isoWeekLabel(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil(( ( (date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

export function deterministicColor(str) {
  const PALETTE=['#e6c07a','#9cc0b5','#d68a8a','#a3b5d6','#c7b29a','#8ec0a5','#d3a0cb','#9aa9c9','#e3c9b2','#82b6b7','#b8a8d8','#d9b6a3'];
  let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0;
  return PALETTE[h%PALETTE.length];
}

export function shuffleArray(arr){
  const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a;
}

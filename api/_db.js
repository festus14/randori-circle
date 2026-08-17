import { createClient } from '@libsql/client';

export function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Missing TURSO_DATABASE_URL");
  return createClient({ url, authToken });
}

export function getJwtSecret() {
  return process.env.JWT_SECRET || 'dev-randori-jwt-secret-change-me';
}

export function getCronSecret() {
  return process.env.CRON_SECRET || getJwtSecret();
}

export function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) {
    // fallback default admin
    return new Set(['festusomole14@gmail.com'.toLowerCase()]);
  }
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

export const DEFAULT_PAIRING_TIME_ZONE='Europe/London';

const BOUNDARY_HOUR=8;
const DAY_MILLISECONDS=24*60*60*1000;
const CRON_UTC_START_MILLISECONDS=8*60*60*1000;
const CRON_UTC_END_MILLISECONDS=10*60*60*1000;
const formatters=new Map();

function validInstant(value){
  const date=value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if(!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid instant');
  return date;
}

function formatterFor(timeZone){
  if(typeof timeZone!=='string'||!timeZone.trim()||timeZone.length>100){
    throw new TypeError('PAIRING_TIME_ZONE must be a valid IANA time zone');
  }
  const requested=timeZone.trim();
  if(formatters.has(requested)) return formatters.get(requested);
  let formatter;
  try{
    formatter=new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn',{
      timeZone:requested,
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',
      hourCycle:'h23',
    });
  }catch{
    throw new TypeError('PAIRING_TIME_ZONE must be a valid IANA time zone');
  }
  const canonical=formatter.resolvedOptions().timeZone;
  const value=Object.freeze({formatter,canonical});
  formatters.set(requested,value);
  return value;
}

function localDateTime(instant,formatter){
  const values={};
  for(const part of formatter.formatToParts(instant)){
    if(part.type!=='literal') values[part.type]=part.value;
  }
  const result={
    year:Number(values.year),month:Number(values.month),day:Number(values.day),
    hour:Number(values.hour),minute:Number(values.minute),second:Number(values.second),
  };
  if(Object.values(result).some(value=>!Number.isInteger(value))){
    throw new TypeError('PAIRING_TIME_ZONE could not resolve a local date');
  }
  return result;
}

function calendarDate(year,month,day){
  const date=new Date(Date.UTC(year,month-1,day));
  return Object.freeze({
    year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),
  });
}

function shiftCalendarDate(value,days){
  return calendarDate(value.year,value.month,value.day+days);
}

function localEpoch(value){
  return Date.UTC(value.year,value.month-1,value.day,value.hour,value.minute,value.second);
}

// Convert a valid local wall-clock time to an instant without depending on the
// host process timezone. Sunday 08:00 is outside DST gaps and folds, while the
// bounded correction loop also validates that assumption for configured zones.
function localBoundaryInstant(date,formatter){
  const target={...date,hour:BOUNDARY_HOUR,minute:0,second:0};
  const targetEpoch=localEpoch(target);
  let candidate=targetEpoch;
  for(let attempt=0;attempt<6;attempt+=1){
    const actual=localDateTime(new Date(candidate),formatter);
    const correction=targetEpoch-localEpoch(actual);
    if(correction===0) return new Date(candidate);
    candidate+=correction;
  }
  const actual=localDateTime(new Date(candidate),formatter);
  if(localEpoch(actual)===targetEpoch) return new Date(candidate);
  throw new TypeError('PAIRING_TIME_ZONE cannot represent the Sunday boundary');
}

function isoWeekId(date){
  const target=new Date(Date.UTC(date.year,date.month-1,date.day));
  const weekday=target.getUTCDay()||7;
  target.setUTCDate(target.getUTCDate()+4-weekday);
  const isoYear=target.getUTCFullYear();
  const yearStart=new Date(Date.UTC(isoYear,0,1));
  const week=Math.ceil((((target-yearStart)/DAY_MILLISECONDS)+1)/7);
  return `${isoYear}-W${String(week).padStart(2,'0')}`;
}

/**
 * Resolve Randori's weekly cycle using local-calendar arithmetic in one IANA
 * timezone. A cycle is the half-open interval from Sunday 08:00 until the next
 * Sunday 08:00. Its ID is the ISO week containing the following Monday.
 */
export function resolvePairingCycle(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)){
    throw new TypeError('pairing cycle options must be an object');
  }
  const now=validInstant(options.now===undefined?new Date():options.now);
  const configuredTimeZone=options.timeZone===undefined
    ? (process.env.PAIRING_TIME_ZONE||DEFAULT_PAIRING_TIME_ZONE)
    : options.timeZone;
  const {formatter,canonical}=formatterFor(configuredTimeZone);
  const state=options.state===undefined?'current':options.state;
  if(state!=='current'&&state!=='upcoming'){
    throw new TypeError("pairing cycle state must be 'current' or 'upcoming'");
  }

  const localNow=localDateTime(now,formatter);
  const localToday=calendarDate(localNow.year,localNow.month,localNow.day);
  const weekday=new Date(Date.UTC(localToday.year,localToday.month-1,localToday.day)).getUTCDay();
  let startDate=shiftCalendarDate(localToday,-weekday);
  let startsAt=localBoundaryInstant(startDate,formatter);
  if(now.getTime()<startsAt.getTime()){
    startDate=shiftCalendarDate(startDate,-7);
    startsAt=localBoundaryInstant(startDate,formatter);
  }
  if(state==='upcoming'){
    startDate=shiftCalendarDate(startDate,7);
    startsAt=localBoundaryInstant(startDate,formatter);
  }
  const endDate=shiftCalendarDate(startDate,7);
  const endsAt=localBoundaryInstant(endDate,formatter);
  const cycleMonday=shiftCalendarDate(startDate,1);

  return Object.freeze({
    cycleId:isoWeekId(cycleMonday),
    startsAt:startsAt.toISOString(),
    endsAt:endsAt.toISOString(),
    cutoffAt:startsAt.toISOString(),
    timeZone:canonical,
    state,
  });
}

/**
 * Vercel Hobby permits one invocation per day, so the scheduler fires at
 * Sunday 08:00 UTC. That is the cycle boundary in GMT and one hour after it in
 * BST. The explicit half-open Sunday [08:00, 10:00) UTC admission window gives
 * the scheduler one bounded retry hour without admitting another weekday.
 */
export function pairingCronIsDue(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)){
    throw new TypeError('pairing cron options must be an object');
  }
  const now=validInstant(options.now===undefined?new Date():options.now);
  const cycle=resolvePairingCycle({now,timeZone:options.timeZone});
  const startsAt=Date.parse(cycle.startsAt);
  const utcMilliseconds=(now.getUTCHours()*60*60*1000)
    +(now.getUTCMinutes()*60*1000)+(now.getUTCSeconds()*1000)+now.getUTCMilliseconds();
  return now.getUTCDay()===0
    &&utcMilliseconds>=CRON_UTC_START_MILLISECONDS
    &&utcMilliseconds<CRON_UTC_END_MILLISECONDS
    &&now.getTime()>=startsAt;
}

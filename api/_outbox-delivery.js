import { randomUUID } from 'node:crypto';
import {
  createPairingEmailHandler,
  createResendEmailSender,
  PAIRING_EMAIL_EVENT_TYPE,
} from './_pairing-email.js';
import {
  createEmailActivationHandler,
  EMAIL_ACTIVATION_EVENT_TYPE,
  emailActivationConfiguration,
} from './_email-activation.js';
import {
  createPasswordResetHandler,
  PASSWORD_RESET_EVENT_TYPE,
  passwordResetConfiguration,
} from './_password-reset.js';
import {
  createScheduleEmailHandler,
  SCHEDULE_EMAIL_EVENT_TYPE,
} from './_schedule-email.js';
import {
  createInvitationEmailHandler,
  invitationEmailConfiguration,
  INVITATION_EMAIL_EVENT_TYPE,
} from './_invitation-email.js';
import {
  createInviteRequestNotificationHandler,
  INVITE_REQUEST_EVENT_TYPE,
  inviteRequestNotificationConfiguration,
} from './_invite-request-notification.js';
import {
  createReminderEmailHandler,
  REMINDER_EMAIL_EVENT_TYPE,
} from './_reminders.js';
import { localIdentityAdapterEnabled, strictLocalPairingRuntime } from './_local-runtime.js';

// Single registry of outbox delivery adapters. Both the scheduled worker
// (`/api/cron/outbox`) and the post-commit immediate attempt build handlers
// here so the two paths can never diverge in provider, template, or policy.
export const OUTBOX_DELIVERY_TYPES=Object.freeze([
  Object.freeze({type:PAIRING_EMAIL_EVENT_TYPE,key:'email_delivery',label:'email reminder'}),
  Object.freeze({type:SCHEDULE_EMAIL_EVENT_TYPE,key:'schedule_delivery',label:'schedule email'}),
  Object.freeze({type:INVITATION_EMAIL_EVENT_TYPE,key:'invitation_delivery',label:'invitation email'}),
  Object.freeze({type:EMAIL_ACTIVATION_EVENT_TYPE,key:'activation_delivery',label:'activation email'}),
  Object.freeze({type:PASSWORD_RESET_EVENT_TYPE,key:'password_reset_delivery',label:'password reset email'}),
  Object.freeze({type:INVITE_REQUEST_EVENT_TYPE,key:'invite_request_delivery',label:'invite request notification'}),
  // Issue #287. Always registered so queued reminders drain (to `suppressed`
  // while REMINDERS_ENABLED is off) instead of aging into a backlog alert.
  Object.freeze({type:REMINDER_EMAIL_EVENT_TYPE,key:'reminder_delivery',label:'reminder email'}),
]);

export function configuredOutboxBaseUrl(){
  let url;
  try{ url=new URL(String(process.env.APP_URL||'')); }
  catch{ return null; }
  const local=process.env.NODE_ENV==='development'&&process.env.RANDORI_LOCAL_RUNTIME==='true';
  const loopback=url.hostname==='127.0.0.1'||url.hostname==='[::1]'||url.hostname==='localhost';
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')
    ||(local?(url.protocol!=='http:'||!loopback):(url.protocol!=='https:'||loopback))){
    return null;
  }
  return url.origin;
}

function localCaptureSender(captured,type){
  return async message=>{
    const kind=type===PAIRING_EMAIL_EVENT_TYPE
      ?(['paired','solo','unavailable'].includes(String(message.kind))
        ?String(message.kind):(String(message.subject).includes('missed')?'unavailable':'paired'))
      :type===SCHEDULE_EMAIL_EVENT_TYPE?'schedule'
        :type===INVITATION_EMAIL_EVENT_TYPE?'invitation'
          :type===PASSWORD_RESET_EVENT_TYPE?'password-reset'
            :type===INVITE_REQUEST_EVENT_TYPE?'invite-request'
              :type===REMINDER_EMAIL_EVENT_TYPE?`reminder-${String(message.kind).replaceAll('_','-')}`
                :'activation';
    captured.get(type).push({recipient_email:String(message.to),kind,subject:String(message.subject),
      links:[...message.html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]).slice(0,4)});
    return {providerName:'local-capture',providerMessageId:`local-${randomUUID()}`};
  };
}

/**
 * Build the configured delivery handlers. `types` restricts construction to a
 * subset (the immediate path only needs the type it just enqueued).
 */
export async function outboxDeliveryPlan(db,baseUrl,req,{types=null}={}){
  const wanted=types===null?null:new Set(types);
  const include=type=>wanted===null||wanted.has(type);
  const local=localIdentityAdapterEnabled(req);
  const captured=new Map(OUTBOX_DELIVERY_TYPES.map(({type})=>[type,[]]));
  let sharedSend=null;
  if(!local&&process.env.RESEND_API_KEY&&process.env.RESEND_FROM){
    const resendMod=await import('resend').catch(()=>null);
    if(resendMod?.Resend){
      sharedSend=createResendEmailSender({
        resend:new resendMod.Resend(process.env.RESEND_API_KEY),from:process.env.RESEND_FROM,
      });
    }
  }
  const sender=type=>local?localCaptureSender(captured,type):sharedSend;
  const handlers=new Map();
  const pairingSend=sender(PAIRING_EMAIL_EVENT_TYPE);
  const scheduleSend=sender(SCHEDULE_EMAIL_EVENT_TYPE);
  const invitationSend=sender(INVITATION_EMAIL_EVENT_TYPE);
  const activationSend=sender(EMAIL_ACTIVATION_EVENT_TYPE);
  const passwordResetSend=sender(PASSWORD_RESET_EVENT_TYPE);
  const inviteRequestSend=sender(INVITE_REQUEST_EVENT_TYPE);
  const reminderSend=sender(REMINDER_EMAIL_EVENT_TYPE);
  if(include(PAIRING_EMAIL_EVENT_TYPE)&&pairingSend) handlers.set(PAIRING_EMAIL_EVENT_TYPE,
    createPairingEmailHandler({db,baseUrl,send:pairingSend,localRuntime:local}));
  if(include(SCHEDULE_EMAIL_EVENT_TYPE)&&scheduleSend) handlers.set(SCHEDULE_EMAIL_EVENT_TYPE,
    createScheduleEmailHandler({db,baseUrl,send:scheduleSend,localRuntime:local}));
  if(include(INVITATION_EMAIL_EVENT_TYPE)&&invitationEmailConfiguration({localRuntime:local})&&invitationSend){
    handlers.set(INVITATION_EMAIL_EVENT_TYPE,createInvitationEmailHandler({
      db,baseUrl,send:invitationSend,localRuntime:local,
    }));
  }
  if(include(EMAIL_ACTIVATION_EVENT_TYPE)&&emailActivationConfiguration()&&activationSend){
    handlers.set(EMAIL_ACTIVATION_EVENT_TYPE,createEmailActivationHandler({
      db,baseUrl,send:activationSend,
    }));
  }
  if(include(PASSWORD_RESET_EVENT_TYPE)&&passwordResetConfiguration()&&passwordResetSend){
    handlers.set(PASSWORD_RESET_EVENT_TYPE,createPasswordResetHandler({
      db,baseUrl,send:passwordResetSend,
    }));
  }
  if(include(INVITE_REQUEST_EVENT_TYPE)&&inviteRequestNotificationConfiguration({localRuntime:local})
    &&inviteRequestSend){
    handlers.set(INVITE_REQUEST_EVENT_TYPE,createInviteRequestNotificationHandler({
      db,baseUrl,send:inviteRequestSend,localRuntime:local,
    }));
  }
  if(include(REMINDER_EMAIL_EVENT_TYPE)&&reminderSend){
    handlers.set(REMINDER_EMAIL_EVENT_TYPE,createReminderEmailHandler({db,baseUrl,send:reminderSend,
      localScope:strictLocalPairingRuntime(req)}));
  }
  return {local,captured,handlers};
}

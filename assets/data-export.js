// Member data export in Edit profile (issue #365, ID-89), behind
// DATA_EXPORT_ENABLED. The server advertises the dataExport capability, so
// nothing is downloaded while the flag is off.
//
// The flow is one click: GET /api/auth/account/export returns the member's
// own data as JSON and the browser downloads it. The server requires a
// sign-in from the last 10 minutes; when that proof has lapsed the button
// tells the member to confirm through Account security (or sign out and sign
// in again) and then try again, instead of this module duplicating the
// identity-confirm dialog. The server authorizes every step again.
// Rendering uses DOM nodes and textContent only.
export const EXPORT_FILENAME='randori-circle-data-export.json';

export const COPY=Object.freeze({
  title:'Download my data',
  intro:'Download a JSON archive of your own Randori data: your profile, memberships, availability, pairings, schedules, completed sessions, your own code runs and messages, and your AI and product feedback.',
  includedTitle:'What the download contains',
  included:Object.freeze([
    'Your profile, memberships, availability and notification preferences.',
    'Your pairings, with partners shown by display name only.',
    'Your schedules, session completions and session controls.',
    'Messages you sent and code runs you made, solo and in pair rooms.',
    'Questions you authored, invitations you sent or accepted, and your own invite requests.',
    'Your AI sessions, AI feedback, AI consent and AI usage, and your own product feedback when feedback is available.',
  ]),
  excludedTitle:'What it does not contain',
  excluded:Object.freeze([
    'Any other member’s private data: partners appear by display name only, and a partner’s chat messages are never included.',
    'Passwords, sign-in tokens, session records or other secrets.',
    'Shared pair workspaces, which hold your partner’s contributions too.',
    'Operational records such as error logs and the email queue.',
  ]),
  reauthHint:'Your sign-in is older than 10 minutes. Confirm it’s you first — open Account security from the account menu and confirm, or sign out and sign in again — then try downloading again.',
  download:'Download my data (JSON)',
  preparing:'Preparing your download…',
  downloaded:'Your data download has started.',
  unavailable:'Download is unavailable right now. Try again in a moment.',
  rateLimited:'Too many download attempts. Wait a few minutes and try again.',
  tooLarge:'Your data is too large to download in one file. Please contact us and we will help you get a copy.',
  signedOut:'You’re signed out. Sign in again to download your data.',
});

/** Serialises an export archive for download, or null when it is not an archive. */
export function exportDownloadText(archive){
  if(!archive||typeof archive!=='object'||Array.isArray(archive)) return null;
  if(archive.format!=='randori-circle-data-export'||archive.version!==1) return null;
  try{ return JSON.stringify(archive,null,2); }catch{ return null; }
}

function node(doc,tag,{className='',text=null,id='',testid=''}={}){
  const element=doc.createElement(tag);
  if(className) element.className=className;
  if(id) element.id=id;
  if(testid) element.dataset.testid=testid;
  if(text!==null) element.textContent=text;
  return element;
}

function button(doc,text,{className='btn',id='',testid=''}={}){
  const element=node(doc,'button',{className,text,id,testid});
  element.type='button';
  return element;
}

function bulletList(doc,title,items){
  const block=node(doc,'div',{className:'recovery-steps'});
  const entries=node(doc,'ul');
  entries.append(...items.map(item=>node(doc,'li',{text:item})));
  block.append(node(doc,'h3',{text:title}),entries);
  return block;
}

function liveStatus(element){
  element.setAttribute('role','status');
  element.setAttribute('aria-live','polite');
  return element;
}

export function mountDataExport({doc,host}){
  const section=doc.getElementById('dataExport');
  if(!section) return null;
  section.setAttribute('aria-labelledby','dataExportTitle');
  const head=node(doc,'div',{className:'card-h'});
  head.append(node(doc,'h2',{id:'dataExportTitle',text:COPY.title}),
    node(doc,'p',{className:'onboarding-lead',text:COPY.intro}));
  const status=liveStatus(node(doc,'p',{className:'small request-status',id:'dataExportStatus',testid:'data-export-status'}));
  const downloadButton=button(doc,COPY.download,{className:'btn',id:'dataExportDownload',testid:'data-export-download'});
  const actions=node(doc,'div',{className:'onboarding-actions'});
  actions.append(downloadButton);
  const body=node(doc,'div',{className:'card-b onboarding-body'});
  body.append(bulletList(doc,COPY.includedTitle,COPY.included),
    bulletList(doc,COPY.excludedTitle,COPY.excluded),status,actions);
  section.replaceChildren(head,body);

  const state={userId:null,busy:false,generation:0};

  function sync(){
    const userId=host.enabled()?host.userId():null;
    if(userId!==state.userId){
      state.userId=userId;
      state.generation+=1;
      state.busy=false;
      downloadButton.disabled=false;
      status.textContent='';
    }
    section.hidden=userId===null;
  }

  async function download(){
    if(state.busy||state.userId===null) return;
    const generation=state.generation;
    state.busy=true;
    downloadButton.disabled=true;
    status.textContent=COPY.preparing;
    try{
      const archive=await host.api('/api/auth/account/export',{method:'GET'});
      if(state.generation!==generation) return;
      const text=exportDownloadText(archive);
      if(text===null) throw Object.assign(new Error('invalid export'),{http_status:503});
      host.download(EXPORT_FILENAME,text);
      status.textContent=COPY.downloaded;
    }catch(error){
      if(state.generation!==generation) return;
      const code=String(error?.code||'');
      const message=String(error?.error||'');
      const httpStatus=Number(error?.http_status);
      if(code==='recent_auth_required'||message==='recent authentication required'){
        status.textContent=COPY.reauthHint;
      }else if(httpStatus===429){
        status.textContent=COPY.rateLimited;
      }else if(code==='export_too_large'||httpStatus===413){
        status.textContent=COPY.tooLarge;
      }else if(httpStatus===401){
        status.textContent=COPY.signedOut;
      }else{
        status.textContent=COPY.unavailable;
      }
    }finally{
      if(state.generation===generation){
        state.busy=false;
        downloadButton.disabled=false;
      }
    }
  }

  downloadButton.addEventListener('click',()=>{ void download(); });

  return {
    sync,
    get state(){ return {userId:state.userId,busy:state.busy}; },
  };
}

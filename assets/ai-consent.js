// Personal consent is server-authoritative. The room-layout localStorage
// preference only hides tools and never grants or withdraws this choice.
export const COPY=Object.freeze({
  title:'Allow AI feedback on this session?',
  personal:'If you allow it, Randori will send your session notes, the code in this room, and the interviewer questions to Groq (with OpenAI as a backup) to generate coaching feedback for you and your partner. It will not send your name or email, or your chat messages or whiteboard. The notes, code and feedback will be kept while your account exists. AI feedback is a beta — check it before you act on it.',
  everyone:"Everyone in this room must allow it. If your partner hasn't yet, Get feedback will wait for them.",
  privacy:'Read how AI feedback works in the Privacy Policy',
  partnerTitle:'Your partner asked for AI feedback on this session.',
  partner:"If you allow it, Randori will send this room's session notes and code to Groq (with OpenAI as a backup) to generate coaching feedback. It will not send your name or email, or your chat messages or whiteboard. Allowing it saves your choice for future sessions too — you can withdraw it at any time in Edit profile.",
  withdrawTitle:'Withdraw AI feedback consent?',
  withdraw:'Randori will stop sending your sessions to AI providers. Past feedback stays available unless you delete your account.',
  allowed:'AI feedback allowed — withdraw it in Edit profile',
  unavailable:'AI feedback is unavailable',
  excluded:'OpenAI is a backup to Groq. Your name, email, chat messages and whiteboard are not sent.',
});

export function confirmationText(payload,snapshotCount){
  return `Send this session's notes (${payload.transcript.length} characters), code (${snapshotCount} snapshots + latest code) and interviewer questions to Groq / OpenAI for feedback?`;
}

export function partnerState(count){
  return count>0?`Waiting for ${count} participant${count===1?'':'s'} to allow AI feedback…`:'Your partner has allowed AI feedback.';
}

export function aiErrorText(status,body={}){
  if(status===503) return COPY.unavailable;
  if(status===403 && body.error==='AI consent required from every room participant'){
    if(body.processing_started) return 'AI consent was withdrawn while feedback was being generated. No new feedback was saved. Past feedback stays available.';
    const n=Number(body.pending_participant_count)||1;
    return `Waiting for ${n} participant${n===1?'':'s'} to allow AI feedback. Nothing was sent to the AI provider and no feedback was created.`;
  }
  if(status===403 && /trusted room|single-user/.test(body.error||'')) return 'AI feedback is not available for this room.';
  if(status===401) return 'Sign in to request AI feedback.';
  if(status===429) return 'You have reached the AI feedback limit for now. Try again later.';
  return 'AI feedback is not available right now. Try again later.';
}

function node(doc,tag,text,className=''){
  const element=doc.createElement(tag);
  if(text!==undefined) element.textContent=text;
  if(className) element.className=className;
  return element;
}
function button(doc,text){ const element=node(doc,'button',text,'btn secondary sm'); element.type='button'; return element; }

export function mountAiConsent({doc,win,host}){
  const status=doc.getElementById('aiConsentStatus');
  const banner=doc.getElementById('aiPartnerConsent');
  const inline=doc.getElementById('aiAnalysisConfirm');
  const profile=doc.getElementById('aiConsentProfile');
  let generation=0,sequence=0,busy=false,state=null,cancelAsk=null,dismissedRoom=null;
  const actor=()=>host.userId();
  const room=()=>host.roomId();
  const identity=()=>`${actor()||''}:${room()||''}:${generation}`;

  function setStatus(text){ if(status) status.textContent=text; }
  function reset(){
    generation+=1; sequence+=1; state=null; busy=false; dismissedRoom=null;
    cancelAsk?.(); cancelAsk=null;
    banner.hidden=true; inline.hidden=true; profile.hidden=!actor();
    setStatus('');
    void refresh();
  }
  function ask({title,paragraphs,allow,cancel,privacy=false,inlineConfirm=false}){
    return new Promise(resolve=>{
      const container=inlineConfirm?inline:node(doc,'dialog',undefined,'ai-consent-dialog card');
      container.replaceChildren();
      const heading=node(doc,'h3',title); heading.id=inlineConfirm?'aiAnalysisConfirmTitle':'aiConsentDialogTitle';
      container.setAttribute('aria-labelledby',heading.id);
      container.append(heading,...paragraphs.map(text=>node(doc,'p',text,'small')));
      if(privacy){ const link=node(doc,'a',COPY.privacy); link.href='privacy.html'; link.target='_blank'; link.rel='noopener'; container.append(link); }
      const actions=node(doc,'div',undefined,'row');
      const no=button(doc,cancel),yes=button(doc,allow); yes.className='btn sm';
      no.autofocus=true; actions.append(no,yes); container.append(actions);
      const prior=doc.activeElement;
      const finish=answer=>{
        cancelAsk=null;
        if(inlineConfirm){ container.hidden=true; }
        else { container.close(); container.remove(); }
        if(prior?.isConnected && !prior.disabled) prior.focus();
        resolve(answer);
      };
      cancelAsk=()=>finish(false);
      no.onclick=()=>finish(false); yes.onclick=()=>finish(true);
      if(inlineConfirm){
        container.hidden=false; no.focus();
        container.onkeydown=event=>{ if(event.key==='Escape'){ event.preventDefault(); finish(false); } };
      }else{
        container.addEventListener('cancel',event=>{ event.preventDefault(); finish(false); });
        doc.body.append(container); container.showModal(); no.focus();
      }
    });
  }
  async function read(withRoom){
    const query=withRoom&&/^week_[1-9]\d*_pair_[1-9]\d*$/.test(room())?`?room_id=${encodeURIComponent(room())}`:'';
    return host.request(`/api/ai/consent${query}`);
  }
  function renderProfile(value){
    profile.hidden=!actor();
    profile.replaceChildren();
    const heading=node(doc,'h2','AI feedback'); heading.id='aiConsentProfileTitle';
    profile.setAttribute('aria-labelledby',heading.id);
    const head=node(doc,'div',undefined,'card-h'); head.append(heading);
    const body=node(doc,'div',undefined,'card-b');
    const line=value?.consented?`You allowed AI feedback on ${new Date(value.consented_at.replace(' ','T')+'Z').toLocaleDateString()}.`:'You have not allowed AI feedback under the current terms.';
    body.append(node(doc,'p',line,'small'));
    if(value?.consented){ const withdraw=button(doc,'Withdraw consent'); withdraw.id='aiWithdrawConsent'; withdraw.onclick=()=>void revoke(); body.append(withdraw); }
    profile.append(head,body);
  }
  function render(value){
    state=value; renderProfile(value);
    status.replaceChildren();
    if(!value.available){ setStatus(COPY.unavailable); banner.hidden=true; return; }
    if(value.consented){
      const link=node(doc,'a',COPY.allowed); link.href='#view-profile-setup';
      link.onclick=event=>{ event.preventDefault(); host.editProfile(); };
      status.append(link);
    }
    banner.hidden=!!value.consented || !value.feedback_requested || dismissedRoom===room();
    banner.replaceChildren();
    if(!banner.hidden){
      const allow=button(doc,'Allow AI feedback'),later=button(doc,'Not now');
      allow.id='aiPartnerAllow'; later.onclick=()=>{ dismissedRoom=room(); banner.hidden=true; };
      allow.onclick=()=>void allowPartner();
      banner.append(node(doc,'h3',COPY.partnerTitle),node(doc,'p',COPY.partner,'small'),later,allow);
    }
  }
  async function refresh(){
    if(!actor()) return;
    const key=identity(),requestSequence=++sequence;
    try{
      const value=await read(true);
      if(key===identity()&&requestSequence===sequence&&!busy) render(value);
    }catch(error){ if(key===identity()&&!busy){ banner.hidden=true; setStatus(aiErrorText(error.http_status,error)); } }
  }
  async function refreshProfile(){
    if(!actor()){ profile.hidden=true; return; }
    const key=identity();
    try{ const value=await read(false); if(key===identity()) renderProfile(value); }
    catch{ if(key===identity()){ renderProfile(null); profile.append(node(doc,'p','AI consent status is unavailable. Try again later.','small')); } }
  }
  async function allowPartner(){
    if(busy) return;
    busy=true; const key=identity();
    try{
      const value=await read(true);
      if(key!==identity()) return;
      if(!value.available){ setStatus(COPY.unavailable); return; }
      const saved=await host.request('/api/ai/consent',{ai_consent:true,room_id:room()});
      if(key===identity()) render(saved);
    }catch(error){ if(key===identity()) setStatus(aiErrorText(error.http_status,error)); }
    finally{ if(key===identity()) busy=false; }
  }
  async function revoke(){
    if(busy) return;
    busy=true; const key=identity();
    try{
      const yes=await ask({title:COPY.withdrawTitle,paragraphs:[COPY.withdraw],allow:'Withdraw',cancel:'Keep consent'});
      if(!yes||key!==identity()) return;
      const saved=await host.request('/api/ai/consent',{ai_consent:false});
      if(key===identity()){ render(saved); setStatus('AI feedback consent withdrawn. Past feedback stays available.'); }
    }catch(error){ if(key===identity()) setStatus(aiErrorText(error.http_status,error)); }
    finally{ if(key===identity()) busy=false; }
  }
  async function prepare(collect){
    if(busy) return null;
    if(!actor()){ setStatus('Sign in to request AI feedback.'); return null; }
    busy=true; const key=identity();
    try{
      let value=await read(true);
      if(key!==identity()) return null;
      if(!value.available){ setStatus(COPY.unavailable); return null; }
      if(!value.consented){
        const yes=await ask({title:COPY.title,paragraphs:[COPY.personal,COPY.everyone],allow:'Allow AI feedback',cancel:'Not now',privacy:true});
        if(!yes||key!==identity()) return null;
        value=await host.request('/api/ai/consent',{ai_consent:true,room_id:room()});
        if(key!==identity()) return null;
      }
      render(value);
      const {payload,snapshotCount}=collect();
      const yes=await ask({title:confirmationText(payload,snapshotCount),paragraphs:[partnerState(value.pending_participant_count),COPY.excluded],allow:'Send to AI',cancel:'Cancel',inlineConfirm:true});
      if(!yes||key!==identity()) return null;
      // Never upsert consent here: a withdrawal on another device between
      // the status read and Send must stick at the analyze backstop.
      return {...payload,ai_consent:true};
    }catch(error){ if(key===identity()) setStatus(aiErrorText(error.http_status,error)); return null; }
    finally{ if(key===identity()) busy=false; }
  }
  win.addEventListener('randori:room-change',reset);
  win.addEventListener('randori:auth-refreshed',reset);
  win.addEventListener('focus',()=>void refresh());
  doc.getElementById('roomTab-notes')?.addEventListener('click',()=>void refresh());
  // Observe partner choices while the room panel is open, with no email.
  win.setInterval(()=>{ if(doc.visibilityState==='visible'&&doc.getElementById('aiPanel')?.getClientRects().length&&!busy) void refresh(); },10000);
  void refresh();
  return {prepare,refresh,refreshProfile,get state(){return state;}};
}

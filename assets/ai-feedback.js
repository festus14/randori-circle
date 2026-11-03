import {mountAiConsent,aiErrorText} from '/assets/ai-consent.js';
// One consent-aware AI frontend, with local recording and durable history.
(function(){
  function authHeaders(extra={}){
    return {'content-type':'application/json', ...extra};
  }
  // Members see plain status copy. Model routing, token cost and quota
  // details stay in the admin-only debug panel.
  function aiDebugPanel(){
    const el=document.getElementById('aiRouterDebug');
    if(!el) return null;
    if(window._randori_logs?.isAdmin) return el;
    el.style.display='none'; el.replaceChildren();
    return null;
  }
  function showLoader(el){
    try{ if(window._randori_ui && window._randori_ui.showLoader){ return window._randori_ui.showLoader(el); } }catch{}
    if(!el) return null;
    const s=document.createElement('div'); s.className='spinner spinner-sm'; s.textContent=''; el.prepend(s); return s;
  }
  function hideLoader(el){
    try{ if(window._randori_ui && window._randori_ui.hideLoader){ window._randori_ui.hideLoader(el); return; } }catch{}
    if(!el) return; el.querySelectorAll('.spinner').forEach(x=>x.remove());
  }
  function getRoom(){
    try{
      return (window._randori_code && window._randori_code.currentRoom) || window.currentRoom || document.getElementById('roomSelect')?.value || localStorage.getItem('randori-last-room') || 'manual';
    }catch{ return 'manual'; }
  }
  function getPairLabel(){
    try{ return document.getElementById('roomLabel')?.textContent || document.getElementById('videoRoomLabel')?.textContent || getRoom(); }catch{ return getRoom(); }
  }
  function collectPayload(roomOverride, extra){
    const room = roomOverride && typeof roomOverride==='string' ? roomOverride : getRoom();
    const transcriptEl=document.getElementById('aiTranscript');
    const iqEl=document.getElementById('aiInterviewerQs');
    const editor = document.getElementById('editor');
    let codeW=''; 
    try{
      if(window._randori_code && typeof window._randori_code.getCode==='function'){ codeW=window._randori_code.getCode(); }
      else if(window._randori_monaco && window._randori_monaco.editor) { codeW=window._randori_monaco.editor.getValue(); }
      else if(editor) codeW=editor.value||'';
    }catch{}
    // if snaps present use them
    let snaps=[]; try{ snaps = (window._randori_ai && window._randori_ai._snapsRaw) || window._randori_ai?.snaps || []; }catch{}
    if(!snaps.length){ try{ snaps=window._randori_ai?.snaps||[] }catch{} }
    const transcript = (extra && extra.transcript) || transcriptEl?.value?.trim() || '';
    const interviewerQs = (extra && extra.interviewer_questions) || (extra && extra.interviewerQuestions) || iqEl?.value?.trim() || '';
    const duration = (extra && (extra.duration_sec||extra.duration)) || (window._randori_ai && window._randori_ai._startTime ? Math.round((Date.now()-window._randori_ai._startTime)/1000) : 0);
    const roleEl = document.getElementById('roleToggle'); const role = (extra && extra.role) || (roleEl?.textContent?.toLowerCase?.().includes('interviewer') ? 'interviewer' : 'both');
    let combinedCode = codeW;
    if(snaps && snaps.length){ try{ combinedCode = JSON.stringify(snaps) + '\nLATEST:\n' + String(codeW); }catch{ combinedCode=codeW; } }
    if(extra && extra.code) combinedCode = extra.code;
    return {
      room_id: room,
      pair_label: getPairLabel(),
      transcript,
      code: combinedCode,
      interviewer_questions: interviewerQs,
      duration_sec: duration,
      role
    };
  }

  // Enhanced internal state mirror if previous recording vars exist
  let recording=false; let startT=0; let snapsCache=[]; let timer=null;

  // Rewire legacy elements if already present
  function ensureFeedbackListAlias(){
    const fb=document.getElementById('aiFeedback');
    let list=document.getElementById('aiFeedbackList');
    if(!list && fb){
      list=document.createElement('div'); list.id='aiFeedbackList'; list.style.display='grid'; list.style.gap='10px';
      // insert after feedback or clone content migration
      fb.parentElement?.appendChild(list);
    }
    return list;
  }

  async function request(path,body){
    const res=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:authHeaders(),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await res.json();
    if(!res.ok) throw {...value,http_status:res.status};
    return value;
  }
  const consent=mountAiConsent({doc:document,win:window,host:{
    userId:()=>window._randori_auth?.me?.id||window._randori_auth?.me?.uid||null,
    roomId:getRoom,
    request,
    editProfile:()=>document.getElementById('meProfile')?.click(),
  }});
  window._randori_ai_consent=consent;

  let analyzing=false;
  async function analyze(){
    if(analyzing) return {ok:false,cancelled:true};
    analyzing=true;
    const payload=await consent.prepare(()=>({payload:collectPayload(),snapshotCount:window._randori_ai?.snaps?.length||0}));
    if(!payload){ analyzing=false; return {ok:false,cancelled:true}; }

    const aiPanel=document.getElementById('aiPanel');
    const fbEl=document.getElementById('aiFeedback') || document.getElementById('aiFeedbackList');
    const dbgEl=aiDebugPanel();
    const statusEl=document.getElementById('aiStatus');
    const listAlias=ensureFeedbackListAlias();

    // loader
    let loaderTarget = fbEl || aiPanel;
    const spin=showLoader(loaderTarget);
    if(statusEl) statusEl.textContent='Requesting AI feedback…';
    if(dbgEl){ dbgEl.style.display='block'; dbgEl.innerHTML='⏳ picking model: short→8b-instant, long/system-design→70b-versatile, respecting free-tier…'; }

    if(fbEl) fbEl.innerHTML=''; if(listAlias) listAlias.innerHTML='';

    try{
      const headers=authHeaders();
      const res=await fetch('/api/ai/analyze', { method:'POST', headers, body: JSON.stringify(payload) });
      const j=await res.json().catch(()=>({ok:false, error:'bad json'}));
      if(!res.ok){
        if(statusEl){ statusEl.textContent=aiErrorText(res.status,j); statusEl.style.color='var(--color-danger)'; }
        try{ window._randori_ui && window._randori_ui.hideLoader && window._randori_ui.hideLoader(loaderTarget); }catch{}
        try{ window.toast && window.toast(aiErrorText(res.status,j)); }catch{}
        if(dbgEl) dbgEl.innerHTML+=`<br><span style="color:var(--color-danger)">Error ${escapeHtml(res.status)}: ${escapeHtml((j.error||j.reason||'').slice(0,300))} ${j.count? '('+escapeHtml(j.count)+'/'+escapeHtml(j.limit)+')':''}</span>`;
        if(res.status===429){
          try{ window._randori_log && window._randori_log.warn('ai_quota', `blocked ${j.reason||j.error}`, {status:res.status, count:j.count, limit:j.limit}); }catch{}
        }
        throw {...j, http_status:res.status};
      }

      // success render (reuse existing render logic if available, else custom minimal)
      const fb=j.feedback; const model=j.model_used; const reason=j.reason_for_pick; const cost=j.estimated_cost; const ev=j.evidence_validated; const quota=j.quota;
      if(dbgEl){
        dbgEl.innerHTML=`<b>Model:</b> ${escapeHtml(model)}<br><b>Why:</b> ${escapeHtml(reason)}<br><b>Cost:</b> $${escapeHtml(cost?.usd||'0.0000')} (${escapeHtml(cost?.tokens_in||0)} in / ${escapeHtml(cost?.tokens_out||0)} out)${cost?.groq_usage? ' — Groq '+escapeHtml(JSON.stringify(cost.groq_usage)):''}<br><b>Evidence:</b> ${escapeHtml(ev?.validated||0)}/${escapeHtml(ev?.total||0)} validated (${escapeHtml(Math.round((ev?.score||0)*100))}%) ${ev?.loweredConfidence?'— some lowered confidence':''}<br><b>Anon:</b> ${j.anon?'yes (demo mocked)':'no'} ${j.mocked?'— <span style="color:var(--color-warning)">Mocked — set GROQ_API_KEY</span>':''} ${j.openaiFallback?'— OpenAI fallback':''}${quota? '<br><b>Month:</b> '+escapeHtml(quota.count||0)+'/'+escapeHtml(quota.limit||100)+' '+(quota.demo?' (demo)':'') : ''}`;
      }

      function chip(evTxt){
        if(!evTxt || evTxt==='no direct quote' || String(evTxt).includes('no direct')) return `<span class="kbd status-chip status-warning">no direct quote</span>`;
        const safe=escapeHtml(evTxt);
        return `<span class="kbd status-chip status-success" title="${safe}">“${safe.slice(0,80)}${safe.length>80?'…':''}”</span>`;
      }

      const candidate=fb?.candidate||{strengths:[], improvements:[]};
      const interviewer=fb?.interviewer||{strengths:[], improvements:[]};
      const html=`
        <div class="card" style="border-color:var(--color-success)"><div class="card-h"><h3 style="font-size:13px">Candidate ${fb?.overall_score? `<span class="kbd">${escapeHtml(fb.overall_score)}/10</span>`:''}</h3></div>
          <div class="card-b" style="display:grid;gap:8px">
            <div><b class="small">Strengths</b><div style="display:grid;gap:6px;margin-top:4px">${(candidate.strengths||[]).map(s=>`<div class="test" style="border-color:var(--color-success)"><div class="small"><b>${escapeHtml(s.point)}</b> ${chip(s.evidence)} ${s.confidence? `<span class="kbd">${escapeHtml(Math.round((s.confidence||0.8)*100))}%</span>`:''}</div></div>`).join('')||'<span class="small muted">none listed</span>'}</div></div>
            <div><b class="small">Improvements</b><div style="display:grid;gap:6px;margin-top:4px">${(candidate.improvements||[]).map(s=>`<div class="test" style="border-color:var(--color-danger)"><div class="small"><b>${escapeHtml(s.point)}</b> ${chip(s.evidence)}<div class="small muted" style="margin-top:3px">↳ ${escapeHtml(s.suggestion||'')}</div></div></div>`).join('')||'<span class="small muted">none</span>'}</div></div>
          </div>
        </div>
        <div class="card" style="border-color:var(--color-action)"><div class="card-h"><h3 style="font-size:13px">Interviewer</h3></div>
          <div class="card-b" style="display:grid;gap:8px">
            <div><b class="small">Strengths</b><div style="display:grid;gap:6px;margin-top:4px">${(interviewer.strengths||[]).map(s=>`<div class="test"><div class="small"><b>${escapeHtml(s.point)}</b> ${chip(s.evidence)}</div></div>`).join('')||'<span class="small muted">none</span>'}</div></div>
            <div><b class="small">Improvements</b><div style="display:grid;gap:6px;margin-top:4px">${(interviewer.improvements||[]).map(s=>`<div class="test"><div class="small"><b>${escapeHtml(s.point)}</b> ${chip(s.evidence)}<div class="small muted">↳ ${escapeHtml(s.suggestion||'')}</div></div></div>`).join('')||'<span class="small muted">none</span>'}</div></div>
          </div>
        </div>
        <div class="card" style="border-style:dashed"><div class="card-h"><h3 style="font-size:13px">Next time checklist</h3><span class="kbd">overall ${escapeHtml(fb?.overall_score||'-')}/10</span></div><div class="card-b small">${(fb?.next_time_checklist||[]).map(x=>`• ${escapeHtml(x)}`).join('<br>')||'no checklist'}</div></div>
      `;

      if(fbEl) fbEl.innerHTML=html;
      if(listAlias && listAlias!==fbEl) listAlias.innerHTML=html;
      if(statusEl){ statusEl.textContent=`AI feedback ready${j.anon?' (demo)':''}.`; statusEl.style.color='var(--color-success)'; }
      try{ window.toast && window.toast('AI feedback ready'); }catch{}
      try{ window._randori_log && window._randori_log.success && window._randori_log.success('ai_feedback_ready', `ready ${model} ${ev?.validated||0}/${ev?.total||0}`, {model, room:payload.room_id}); }catch{}

      // populate history widget recently
      return { ok:true, ...j };

    }catch(e){
      const msg=e.error||e.reason||e.message||'analyze failed';
      if(statusEl){ statusEl.textContent=aiErrorText(Number(e?.http_status)||0,e); statusEl.style.color='var(--color-danger)'; }
      try{ console.warn('[ai analyze fail]', e); }catch{}
      return { ok:false, error:msg };
    }finally{
      analyzing=false;
      hideLoader(loaderTarget);
      const btn=document.getElementById('aiAnalyzeBtn'); if(btn){ btn.disabled=false; btn.textContent='Get feedback'; }
    }
  }

  async function getFeedback(id){
    if(!id) return {ok:false, error:'id required'};
    const headers=authHeaders();
    const res=await fetch(`/api/ai/feedback/${encodeURIComponent(id)}`, {headers});
    const j=await res.json().catch(()=>({}));
    if(!res.ok) return {ok:false, error:j.error||String(res.status), detail:j};
    // render if fb element present and caller expects UI
    try{
      const fbEl=document.getElementById('aiFeedback')||document.getElementById('aiFeedbackList');
      if(fbEl && j.feedback){
        // reuse analyze render minimal (just show overall)
        fbEl.innerHTML=`<div class="card"><div class="card-h"><h3>Feedback #${escapeHtml(id)}</h3><span class="kbd">${escapeHtml(j.model_used||'model')}</span></div><div class="card-b"><pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(JSON.stringify(j.feedback,null,2).slice(0,3000))}</pre></div></div>`;
      }
    }catch{}
    return j;
  }

  async function listHistory(){
    const headers=authHeaders();
    const res=await fetch('/api/ai/history', {headers});
    const j=await res.json().catch(()=>({feedbacks:[]}));
    const fbEl=document.getElementById('aiFeedback');
    const listEl=document.getElementById('aiFeedbackList');
    if(!res.ok){
      try{ window.toast && window.toast('Past feedback could not load. Try again.'); }catch{}
      return j;
    }
    const list=j.feedbacks||[];
    const html=`<div class="small muted">${escapeHtml(list.length)} past feedback session${list.length===1?'':'s'}${j.monthly? ' · '+escapeHtml(j.monthly.count)+' of '+escapeHtml(j.monthly.limit)+' used this month'+(j.monthly.demo?' (demo)':''):''}</div><div style="display:grid;gap:6px;margin-top:6px">${list.slice(0,10).map(r=>`<div class="test ai-feedback-history-item" data-feedback-id="${escapeHtml(r.session_id||r.id)}" style="cursor:pointer"><div class="small">${escapeHtml(r.pair_label||'Practice session')} ${r.duration_sec? '• '+escapeHtml(Math.round(r.duration_sec/60))+'m':''} <span class="kbd" style="float:right">${escapeHtml(new Date(r.created_at).toLocaleString())}</span></div></div>`).join('')||'<span class="small muted">No history yet — run an analysis above</span>'}</div>`;
    const target = fbEl || listEl;
    if(target){ target.innerHTML=html; }
    if(listEl && listEl!==fbEl){ listEl.innerHTML=html; }
    document.querySelectorAll('.ai-feedback-history-item').forEach(el=>el.addEventListener('click', ()=>getFeedback(el.dataset.feedbackId)));
    const statusEl=document.getElementById('aiStatus'); if(statusEl) statusEl.textContent=`Showing ${list.length} past feedback session${list.length===1?'':'s'}.`;
    return j;
  }

  // extend / override global
  const prev=window._randori_ai||{};
  const enhanced={
    get recording(){ try{ return prev.recording; }catch{ return recording; } },
    get snaps(){ try{ const s=prev.snaps||[]; if(s.length) return s; }catch{} return snapsCache; },
    get _snapsRaw(){ return snapsCache; },
    get _startTime(){ return prev._startTime||startT; },
    analyze,
    getFeedback,
    get_feedback:getFeedback,
    listHistory,
    get history(){ return listHistory; },
    analyzeRoom: analyze,
    // compat wrappers
    record: ()=>document.getElementById('aiRecordBtn')?.click()
  };

  window._randori_ai = new Proxy(enhanced, {
    get(t,p){ if(p in t) return t[p]; if(p in prev) return prev[p]; return undefined; },
    set(t,p,v){ t[p]=v; return true; }
  });

  // Wire buttons robustly (override previous onclick)
  const ab=document.getElementById('aiAnalyzeBtn');
  const hb=document.getElementById('aiHistoryBtn');
  if(ab) ab.onclick=()=>analyze();
  if(hb) hb.onclick=()=>listHistory();

  // Record button sync — keep existing behavior but also cache snaps
  try{
    const rb=document.getElementById('aiRecordBtn');
    if(rb && !rb._enhancedWired){
      rb._enhancedWired=true;
      const origClick=rb.onclick;
      rb.addEventListener('click', ()=>{
        setTimeout(()=>{
          try{
            recording = !!(window._randori_ai && window._randori_ai.recording);
            if(recording){ startT=Date.now(); snapsCache=[]; }
            else { snapsCache = (window._randori_ai && window._randori_ai.snaps) || snapsCache; }
          }catch{}
        }, 50);
      });
    }
  }catch{}

  // expose helper for debug console
  window._randori_ai_debug={ analyze, getFeedback, listHistory, getRoom, collectPayload };
})();

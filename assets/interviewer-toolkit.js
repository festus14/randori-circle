// Optional first-use module (#465, ID-102): no notes in storage, logs or AI.
let view=null,epoch=0,abort=null,downloadUrl=null;
const DIMENSIONS=[['problem_solving','Problem solving'],['communication','Communication'],['code_quality','Code quality'],['testing','Testing']];
const DECISIONS=[['undecided','Undecided'],['strong_hire','Strong hire'],['hire','Hire'],['no_hire','No hire'],['strong_no_hire','Strong no hire']];
export function disposeToolkit(){
  epoch+=1;abort?.abort();abort=null;
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}
  view?.remove();view=null;
}
function node(tag,text,attributes={}){
  const element=document.createElement(tag);if(text!==null)element.textContent=text;
  for(const [key,value] of Object.entries(attributes))element.setAttribute(key,value);
  return element;
}
export function describeEvent(event){
  if(event.kind==='phase')return `${event.phase} · ${event.source}`;
  if(event.kind==='checkpoint')return `Checkpoint r${event.revision} · ${event.question_slug} · ${event.language}`;
  if(event.kind==='run')return `Run · ${event.question_slug} · ${event.language} · ${event.passed_count}/${event.total_count} passed · ${event.duration_ms} ms`;
  return 'Evaluation saved';
}
export function reportDownload(report){
  return JSON.stringify(report,null,2)+'\n';
}
export async function openToolkit(room){
  disposeToolkit();const generation=epoch;abort=new AbortController();
  const dialog=node('dialog',null,{class:'ai-consent-dialog auth-dialog','aria-labelledby':'toolkit-title','data-testid':'interviewer-toolkit'});view=dialog;
  const title=node('h2','Private interviewer toolkit',{id:'toolkit-title'});
  const notice=node('p','Only your account can read this writing. It is never shared with the candidate or sent to AI. Scores: 1 = needs support, 2 = developing, 3 = solid, 4 = strong. Notes expire 90 days after first save.');
  const status=node('p','Loading private report…',{role:'status','aria-live':'polite','data-testid':'toolkit-status'});
  const close=node('button','Close',{type:'button',class:'btn secondary'});
  close.addEventListener('click',disposeToolkit);
  dialog.addEventListener('cancel',disposeToolkit);
  dialog.append(title,notice,status,close);document.body.append(dialog);dialog.showModal();
  const url=`/api/interviewer-toolkit?room_id=${encodeURIComponent(room)}`;
  let report=null,dirty=false,position=0;
  const request=async(target,init={})=>{
    let response,data;
    try{response=await fetch(target,{credentials:'same-origin',cache:'no-store',signal:abort.signal,...init});data=await response.json();}
    catch{throw new Error('Private report unavailable.');}
    if(generation!==epoch)throw new Error('stale view');
    if(!response.ok){const error=new Error(response.status===409?'Your saved evaluation changed. Your unsent writing is kept here; reload explicitly before trying again.':'Private report unavailable.');error.status=response.status;throw error;}
    return data;
  };
  try{
    report=(await request(url)).report;
    if(!report||report.room_id!==room)throw new Error('Private report unavailable.');
    const heading=node('p',`${report.candidate} · ${report.phase} · ${room}`);
    const insights=node('p','',{class:'small','data-testid':'toolkit-insights'});
    const form=node('form',null,{'data-testid':'toolkit-form'});
    const fields=new Map();
    const rubric=node('fieldset',null);rubric.append(node('legend','Rubric'));
    for(const [key,label] of DIMENSIONS){
      const id=`toolkit-${key}`,select=node('select',null,{id,name:key,class:'select'});
      for(const [value,text] of [['','Not scored'],['1','1 — Needs support'],['2','2 — Developing'],['3','3 — Solid'],['4','4 — Strong']])select.append(node('option',text,{value}));
      const field=node('label',label,{for:id,class:'notes-field'});field.append(select);rubric.append(field);fields.set(key,select);
    }
    const notes=node('textarea',null,{id:'toolkit-notes',class:'textarea',rows:'6',maxlength:'4000','data-testid':'toolkit-notes'});
    const notesLabel=node('label','Private notes (maximum 4000 characters)',{for:'toolkit-notes',class:'notes-field'});notesLabel.append(notes);
    const decision=node('select',null,{id:'toolkit-decision',class:'select','data-testid':'toolkit-decision'});
    for(const [value,label] of DECISIONS)decision.append(node('option',label,{value}));
    const decisionLabel=node('label','Decision',{for:'toolkit-decision',class:'notes-field'});decisionLabel.append(decision);
    const save=node('button','Save private evaluation',{type:'submit',class:'btn','data-testid':'toolkit-save'});
    const reload=node('button','Reload saved report',{type:'button',class:'btn secondary','data-testid':'toolkit-reload'});
    const download=node('button','Download saved report (JSON)',{type:'button',class:'btn secondary','data-testid':'toolkit-download'});
    const actions=node('div',null,{class:'dialog-actions'});actions.append(save,reload,download);
    form.append(rubric,notesLabel,decisionLabel,actions);
    const retention=node('p','',{class:'small','data-testid':'toolkit-retention'});
    const playback=node('section',null,{'aria-label':'Interview report and playback'});
    playback.append(node('h3','Interview timeline and code evolution'));
    const limits=node('p',report.limitations,{class:'small'});
    const events=node('ol',null,{'data-testid':'toolkit-timeline'});
    const selected=node('p','',{'data-testid':'toolkit-playback-label'});
    const code=node('pre','',{'data-testid':'toolkit-playback-code',class:'msg-body',tabindex:'0'});
    const previous=node('button','Previous event',{type:'button',class:'btn secondary'}),next=node('button','Next event',{type:'button',class:'btn secondary'});
    const controls=node('div',null,{class:'dialog-actions'});controls.append(previous,next);
    playback.append(limits,events,controls,selected,code);
    dialog.insertBefore(heading,close);dialog.insertBefore(insights,close);dialog.insertBefore(form,close);dialog.insertBefore(retention,close);dialog.insertBefore(playback,close);
    function play(index){
      position=Math.min(Math.max(0,index),Math.max(0,report.timeline.length-1));
      const event=report.timeline[position];
      selected.textContent=event?`${position+1}/${report.timeline.length} · ${event.at} · ${describeEvent(event)}`:'No recorded events';
      code.textContent=typeof event?.code==='string'?event.code:'No code snapshot for this event.';
      previous.disabled=position===0;next.disabled=position>=report.timeline.length-1;
    }
    function render(){
      for(const [key,select] of fields)select.value=report.evaluation.rubric[key]??'';
      notes.value=report.evaluation.notes;decision.value=report.evaluation.decision;
      retention.textContent=report.evaluation.expires_at?`Expires ${report.evaluation.expires_at}. Editing does not extend this deadline.`:'Not yet saved.';
      events.replaceChildren();
      report.timeline.forEach((event,index)=>{
        const item=node('li',null),button=node('button',`${event.at} · ${describeEvent(event)}`,{type:'button',class:'btn ghost'});
        button.addEventListener('click',()=>play(index));item.append(button);events.append(item);
      });
      dirty=false;download.disabled=false;play(position);
    }
    render();status.textContent='Private report loaded. Changes are saved only when you press Save.';
    const updateInsights=async()=>{
      try{const mine=await request('/api/interviewer-toolkit');const data=mine.insights;
        insights.textContent=`Your private 90-day insights: ${data.evaluated} evaluated · ${data.decisions.hire+data.decisions.strong_hire} hire · ${data.decisions.no_hire+data.decisions.strong_no_hire} no hire${data.truncated?' (bounded window)':''}.`;
      }catch{if(generation===epoch)insights.textContent='Private insights unavailable.';}
    };
    void updateInsights();
    form.addEventListener('input',()=>{dirty=true;download.disabled=true;status.textContent='Unsent private changes. Save before downloading.';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();save.disabled=true;reload.disabled=true;
      try{
        const rubric=Object.fromEntries([...fields].map(([key,select])=>[key,select.value===''?null:Number(select.value)]));
        await request('/api/interviewer-toolkit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room_id:room,revision:report.evaluation.revision,rubric,notes:notes.value,decision:decision.value})});
        report=(await request(url)).report;render();status.textContent='Private evaluation saved.';void updateInsights();
      }catch(error){if(generation===epoch){if(error.status===404||error.status===401)disposeToolkit();else status.textContent=error.message;}}
      finally{save.disabled=false;reload.disabled=false;}
    });
    reload.addEventListener('click',async()=>{
      if(dirty&&!confirm('Discard unsent private changes and reload the saved report?'))return;
      try{report=(await request(url)).report;render();status.textContent='Saved report reloaded.';}
      catch(error){if(generation===epoch)status.textContent=error.message;}
    });
    previous.addEventListener('click',()=>play(position-1));next.addEventListener('click',()=>play(position+1));
    download.addEventListener('click',()=>{
      if(dirty)return;
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);
      downloadUrl=URL.createObjectURL(new Blob([reportDownload(report)],{type:'application/json'}));
      const link=node('a',null,{href:downloadUrl,download:`randori-interview-${room}.json`});document.body.append(link);link.click();link.remove();
    });
  }catch{if(generation===epoch)status.textContent='Private report unavailable. Close and try again.';}
}
if(typeof window!=='undefined')for(const event of ['randori:auth-refreshed','randori:room-change','randori:workspace-scope-reset','randori:workspace-deactivated'])window.addEventListener(event,disposeToolkit);

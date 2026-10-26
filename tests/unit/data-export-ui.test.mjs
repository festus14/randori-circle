// Issue #365 data export UI: copy, download, re-auth hint, rate-limit /
// too-large / signed-out copy, and request fencing, against a minimal DOM
// and a scripted host.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COPY,
  EXPORT_FILENAME,
  exportDownloadText,
  mountDataExport,
} from '../../assets/data-export.js';

class FakeNode {
  constructor(doc,tag){
    this.doc=doc;
    this.tagName=tag.toUpperCase();
    this.children=[];
    this.dataset={};
    this.attributes={};
    this.listeners={};
    this.hidden=false;
    this.disabled=false;
    this.className='';
    this.value='';
    this._text='';
  }
  get textContent(){ return this._text+this.children.map(child=>child.textContent).join(''); }
  set textContent(value){ this._text=String(value); this.children=[]; }
  append(...nodes){ this.children.push(...nodes); }
  replaceChildren(...nodes){ this.children=nodes; }
  setAttribute(name,value){ this.attributes[name]=String(value); }
  getAttribute(name){ return this.attributes[name]??null; }
  addEventListener(type,listener){ (this.listeners[type]||=[]).push(listener); }
  focus(){ this.doc.activeElement=this; }
  fire(type){ for(const listener of this.listeners[type]||[]) listener({type,target:this}); }
  click(){ if(!this.disabled) this.fire('click'); }
  all(found=[]){ for(const child of this.children){ found.push(child); child.all(found); } return found; }
  byId(id){ return this.all().find(child=>child.id===id)||null; }
}

function fakeDocument({withSection=true}={}){
  const doc={activeElement:null};
  doc.createElement=tag=>new FakeNode(doc,tag);
  doc.body=new FakeNode(doc,'body');
  const section=new FakeNode(doc,'section');
  section.id='dataExport';
  section.hidden=true;
  doc.section=section;
  doc.getElementById=id=>(withSection&&id==='dataExport'?section:null);
  doc.find=id=>section.byId(id)||doc.body.byId(id);
  return doc;
}

const flush=async()=>{ for(let index=0;index<6;index+=1) await Promise.resolve(); };

function problem(status,body={}){ return Object.assign(new Error('request failed'),{http_status:status,...body}); }

function harness({routes={},enabled=true,userId=7}={}){
  const doc=fakeDocument();
  const calls=[];
  const downloads=[];
  const state={enabled,userId};
  const host={
    enabled:()=>state.enabled,
    userId:()=>state.userId,
    api:async(path,options={})=>{
      calls.push(`${options.method||'GET'} ${path}`);
      const route=routes[`${options.method||'GET'} ${path}`];
      if(!route) throw new Error(`unexpected ${path}`);
      return typeof route==='function'?route(options):route;
    },
    download:(filename,text)=>{ downloads.push({filename,text}); },
  };
  const controller=mountDataExport({doc,host});
  return {doc,host,calls,downloads,state,controller,find:id=>doc.find(id)};
}

const ARCHIVE={version:1,format:'randori-circle-data-export',account:{id:7}};

test('the download text is the pretty-printed archive, or null for anything else',()=>{
  assert.equal(exportDownloadText(ARCHIVE),JSON.stringify(ARCHIVE,null,2));
  assert.equal(exportDownloadText(null),null);
  assert.equal(exportDownloadText({version:1}),null);
  assert.equal(exportDownloadText({version:1,format:'other'}),null);
  assert.equal(exportDownloadText([ARCHIVE]),null);
});

test('mounting needs the section; it stays hidden and silent while not allowed',async()=>{
  assert.equal(mountDataExport({doc:fakeDocument({withSection:false}),host:{}}),null);
  const ui=harness({enabled:false});
  ui.controller.sync();
  assert.equal(ui.doc.section.hidden,true);
  assert.deepEqual(ui.calls,[]);
  assert.equal(ui.doc.section.textContent.includes(COPY.title),true,'the explanation is built once, from text nodes');
});

test('the section explains what is included and excluded, then downloads on click',async()=>{
  const ui=harness({routes:{'GET /api/auth/account/export':ARCHIVE}});
  ui.controller.sync();
  assert.equal(ui.doc.section.hidden,false);
  assert.equal(ui.doc.section.getAttribute('aria-labelledby'),'dataExportTitle');
  for(const line of [COPY.title,COPY.intro,...COPY.included,...COPY.excluded,COPY.download]){
    assert.ok(ui.doc.section.textContent.includes(line),line);
  }
  ui.find('dataExportDownload').click();
  await flush();
  assert.deepEqual(ui.calls,['GET /api/auth/account/export']);
  assert.deepEqual(ui.downloads,[{filename:EXPORT_FILENAME,text:JSON.stringify(ARCHIVE,null,2)}]);
  assert.equal(ui.find('dataExportStatus').textContent,COPY.downloaded);
});

test('a stale proof shows the re-auth hint, and a second click retries',async()=>{
  let calls=0;
  const ui=harness({routes:{'GET /api/auth/account/export':()=>{
    calls+=1;
    if(calls===1) throw problem(403,{code:'recent_auth_required',error:'recent authentication required'});
    return ARCHIVE;
  }}});
  ui.controller.sync();
  ui.find('dataExportDownload').click();
  await flush();
  assert.equal(ui.find('dataExportStatus').textContent,COPY.reauthHint);
  assert.deepEqual(ui.downloads,[]);
  ui.find('dataExportDownload').click();
  await flush();
  assert.equal(ui.downloads.length,1);
  assert.equal(ui.find('dataExportStatus').textContent,COPY.downloaded);
});

test('rate limit, too-large, signed-out and generic failures each get their own copy',async()=>{
  const cases=[
    [()=>{ throw problem(429); },COPY.rateLimited],
    [()=>{ throw problem(413,{code:'export_too_large'}); },COPY.tooLarge],
    [()=>{ throw problem(401); },COPY.signedOut],
    [()=>{ throw new Error('boom'); },COPY.unavailable],
    [()=>({version:2}),COPY.unavailable],
  ];
  for(const [route,message] of cases){
    const ui=harness({routes:{'GET /api/auth/account/export':route}});
    ui.controller.sync();
    ui.find('dataExportDownload').click();
    await flush();
    assert.equal(ui.find('dataExportStatus').textContent,message);
    assert.deepEqual(ui.downloads,[]);
  }
});

test('a second click while a download is in flight is ignored, and signing out resets the view',async()=>{
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const ui=harness({routes:{'GET /api/auth/account/export':async()=>{ await gate; return ARCHIVE; }}});
  ui.controller.sync();
  ui.find('dataExportDownload').click();
  ui.find('dataExportDownload').click();
  await flush();
  assert.deepEqual(ui.calls,['GET /api/auth/account/export']);
  ui.state.userId=null;
  ui.controller.sync();
  assert.equal(ui.doc.section.hidden,true);
  release();
  await flush();
  assert.deepEqual(ui.downloads,[],'a late answer for the previous member is dropped');
});

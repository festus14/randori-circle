import { Page, expect } from '@playwright/test';

export const BASE = process.env.E2E_BASE || 'https://randori-circle-self.vercel.app';

export async function clearOnboarding(page: Page){
  await page.addInitScript(() => {
    try{
      const keys=['randori-onboarded','randori-banner-dismissed','randori-onboard-step','randori-profile-done','randori-landing-dismissed','randori-token','randori-me','randori-last-room','randori-was-skipped','randori-prev-avail','randori-reminder-email','randori-reminder-sms','randori-reminder-phone','randori-people','randori-weeks','randori-code'];
      for(const k of keys) localStorage.removeItem(k);
      try{ sessionStorage.clear(); }catch{}
    }catch{}
  });
}

export async function setNoOnboarding(page: Page){
  await page.addInitScript(() => {
    try{
      localStorage.setItem('randori-onboarded','1');
      localStorage.setItem('randori-banner-dismissed','1');
      localStorage.setItem('randori-onboard-step','0');
      localStorage.setItem('randori-profile-done','1');
      localStorage.setItem('randori-landing-dismissed','1');
      localStorage.setItem('randori-last-room','e2e-room');
      // dummy auth so app doesn't stay on landing - isProfileIncomplete(null) = false
      localStorage.setItem('randori-token','e2e-fake-jwt');
      localStorage.setItem('randori-me', JSON.stringify({id:'e2e-1', display_name:'e2e tester', color:'#c8f6a0', is_admin:false, is_demo:false, tz:'Europe/London', interview_focus:'both'}));
    }catch{}
  });
}

export async function ensureAuthed(page: Page){
  await page.addInitScript(() => {
    try{
      localStorage.setItem('randori-token','e2e-fake-jwt');
      localStorage.setItem('randori-me', JSON.stringify({id:'e2e-1', display_name:'e2e tester', color:'#c8f6a0', is_admin:false, is_demo:false, tz:'Europe/London', interview_focus:'both'}));
      localStorage.setItem('randori-onboarded','1');
      localStorage.setItem('randori-banner-dismissed','1');
      localStorage.setItem('randori-profile-done','1');
      localStorage.setItem('randori-landing-dismissed','1');
      localStorage.setItem('randori-last-room','e2e-room');
    }catch{}
  });
}

export async function getToken(page: Page): Promise<string|null> {
  try{
    return await page.evaluate(() => {
      try{ return localStorage.getItem('randori-token'); }catch{ return null; }
    });
  }catch{ return null; }
}

export async function apiLog(page: Page, level: string, event: string, message: string, meta: any = {}){
  try{
    await page.evaluate(async ({level, event, message, meta}) => {
      try{
        const log = (window as any)._randori_log;
        if(log && log.error){
          if(level==='error') log.error(event, message, meta);
          else if(level==='warn') log.warn(event, message, meta);
          else log.info(event, message, meta);
          if(log.flush) log.flush();
        } else {
          await fetch('/api/logs', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({level, event, message, meta})}).catch(()=>{});
        }
      }catch{}
    }, {level, event, message, meta});
  }catch{}
}

export async function ensureCodeView(page: Page){
  await page.evaluate(() => {
    try{
      const views = document.querySelectorAll('.view');
      views.forEach((v:any)=> v.style.display='none');
      const cv = document.getElementById('view-code') as HTMLElement | null;
      if(cv) cv.style.display='block';
      const tabs = document.querySelectorAll('.tab');
      tabs.forEach(t=> t.classList.remove('active'));
      const codeTab = document.querySelector('[data-tab="code"]') as HTMLElement | null;
      if(codeTab) codeTab.classList.add('active');
      // also ensure tabs bar visible for anon
      const tabsEl = document.querySelector('.tabs') as HTMLElement | null;
      if(tabsEl) tabsEl.style.display='flex';
      const circleTab = document.querySelector('[data-tab="circle"]') as HTMLElement | null;
      if(circleTab) (circleTab as HTMLElement).style.display='none';
      // make code layout visible
      const qPane = document.querySelector('.code-layout') as HTMLElement | null;
      if(qPane) (qPane as HTMLElement).style.display='grid';
    }catch{}
  });
}

export async function waitForMonacoOrFallback(page: Page){
  const host = page.locator('#monacoHost');
  const editor = page.locator('#editor');
  const fallback = page.locator('#monacoFallbackNote');

  // Ensure code view visible first so locators can be visible
  await ensureCodeView(page).catch(()=>{});

  // Wait up to 6.5s for either host visible or editor fallback
  await expect.poll(async ()=>{
    const hostVis = await host.isVisible().catch(()=>false);
    const editorVis = await editor.isVisible().catch(()=>false);
    // also consider monaco ready via window
    const winReady = await page.evaluate(()=> {
      try{
        if((window as any).monacoEditor) return true;
        if((window as any)._randori_monaco?.ready) return true;
        // if fallback textarea displayed block we consider ready
        const ta=document.getElementById('editor') as HTMLElement|null;
        if(ta && ta.style.display!=='none' && (ta as any).offsetParent!==null) return true;
        return false;
      }catch{ return false; }
    }).catch(()=>false);
    return hostVis || editorVis || winReady;
  }, {timeout: 7500}).toBe(true);

  const isMonaco = await page.evaluate(() => {
    try{ return !!(window as any).monacoEditor || !!((window as any)._randori_monaco?.ready); }catch{ return false; }
  });

  // Ensure editor textarea usable if no monaco
  if(!isMonaco){
    await page.evaluate(()=>{
      try{
        const ta=document.getElementById('editor') as HTMLElement|null;
        if(ta){ ta.style.display='block'; (ta as HTMLElement).style.flex='1'; (ta as HTMLElement).style.minHeight='360px'; }
        const host=document.getElementById('monacoHost') as HTMLElement|null;
        // leave host but ensure not covering
        if(host) host.style.minHeight='120px';
      }catch{}
    }).catch(()=>{});
  }

  return { isMonaco };
}

export function twoSumCorrectJS(): string {
  return `function twoSum(nums, target){
  const m=new Map();
  for(let i=0;i<nums.length;i++){
    const need=target-nums[i];
    if(m.has(need)) return [m.get(need), i];
    m.set(nums[i], i);
  }
  return [];
}`;
}

export function twoSumBrokenJS(): string {
  return `function twoSum(nums,target){ return []; }`;
}

export function twoSumPythonCorrect(): string {
  return `def two_sum(nums, target):
    m={}
    for i,n in enumerate(nums):
        need=target-n
        if need in m:
            return [m[need], i]
        m[n]=i
    return []
def twoSum(nums, target):
    return two_sum(nums, target)`;
}

export async function setCode(page: Page, code: string){
  // Ensure view is visible before touching
  await ensureCodeView(page).catch(()=>{});
  // Try Monaco first
  const hasMonaco = await page.evaluate(() => {
    try{ const ed=(window as any).monacoEditor; return !!ed && typeof ed.getValue==='function'; }catch{ return false; }
  });
  if(hasMonaco){
    await page.evaluate((c) => {
      try{
        const ed=(window as any).monacoEditor;
        if(ed){ ed.setValue(c); ed.focus(); try{ ed.layout(); }catch{} }
      }catch{}
    }, code);
  } else {
    // use evaluate for textarea (avoid locator.fill visibility issue)
    await page.evaluate((c)=>{
      try{
        const ta=document.getElementById('editor') as HTMLTextAreaElement | null;
        if(ta){
          ta.style.display='block';
          ta.style.flex='1';
          (ta as any).style.minHeight='360px';
          ta.focus();
          ta.value=c;
          ta.dispatchEvent(new Event('input',{bubbles:true}));
          ta.dispatchEvent(new Event('change',{bubbles:true}));
          // also notify legacy persist
          const ev = new CustomEvent('randori-code-change',{detail:{code:c}});
          document.dispatchEvent(ev);
        }
        // also try mirror globals
        try{
          const host=document.getElementById('monacoHost');
          if(host && (host as any).style) (host as any).style.display='none';
        }catch{}
      }catch{}
    }, code);
  }
  // small settle
  await page.waitForTimeout(120);
}

export async function selectLang(page: Page, lang: string){
  await ensureCodeView(page).catch(()=>{});
  const sel = page.locator('#langSelect');
  // Try both visible and via evaluate
  try{
    if(await sel.count()){
      await page.evaluate((l)=>{
        try{
          const el=document.getElementById('langSelect') as HTMLSelectElement|null;
          if(el){ el.value=l; el.dispatchEvent(new Event('change',{bubbles:true})); }
        }catch{}
      }, lang);
      await page.waitForTimeout(300);
      // also try playwright selectOption if still needed
      if(await sel.isVisible().catch(()=>false)){
        await sel.selectOption(lang).catch(()=>{});
      }
    }
  }catch{}
  await page.waitForTimeout(200);
}

export async function selectQuestion(page: Page, slug: string){
  await ensureCodeView(page).catch(()=>{});
  const qSel = page.locator('#questionSelect');
  if(await qSel.count()){
    try{
      await page.evaluate((s)=>{
        try{
          const el=document.getElementById('questionSelect') as HTMLSelectElement|null;
          if(el){ el.value=s; el.dispatchEvent(new Event('change',{bubbles:true})); }
        }catch{}
        try{ localStorage.setItem('randori-last-question', s); }catch{}
      }, slug);
    }catch{}
    try{
      if(await qSel.first().isVisible().catch(()=>false)){
        await qSel.selectOption(slug).catch(()=>{});
      }
    }catch{}
    await page.waitForTimeout(350);
    // If confirm overlay appeared due to existing code (Load starter? prompt), auto-confirm so Run remains clickable
    try{
      const overlay = page.locator('#confirmOverlay');
      if(await overlay.count()){
        const isShow = await overlay.evaluate(el=> el.classList.contains('show')).catch(()=>false);
        if(isShow){
          const ok = page.locator('#confirmOk');
          if(await ok.isVisible().catch(()=>false)){
            await ok.click().catch(()=>{});
            await page.waitForTimeout(200);
          } else {
            // fallback evaluate click
            await page.evaluate(()=>{
              try{
                const ok2=document.getElementById('confirmOk') as HTMLElement|null;
                if(ok2) ok2.click();
                else {
                  const ov=document.getElementById('confirmOverlay'); if(ov) ov.classList.remove('show');
                }
              }catch{}
            });
          }
        }
      }
    }catch{}
    await page.waitForTimeout(150);
  } else {
    await page.evaluate((s)=>{
      try{ localStorage.setItem('randori-last-question', s); }catch{}
    }, slug);
  }
}

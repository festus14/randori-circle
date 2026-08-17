import { Page, expect } from '@playwright/test';

export const BASE = process.env.E2E_BASE || 'https://randori-circle-self.vercel.app';

export async function clearOnboarding(page: Page){
  await page.addInitScript(() => {
    try{
      localStorage.removeItem('randori-onboarded');
      localStorage.removeItem('randori-banner-dismissed');
      localStorage.removeItem('randori-onboard-step');
      localStorage.removeItem('randori-profile-done');
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

export async function waitForMonacoOrFallback(page: Page){
  const host = page.locator('#monacoHost');
  const editor = page.locator('#editor');
  const fallback = page.locator('#monacoFallbackNote');

  // Wait up to 6s for either host visible or editor fallback
  await expect.poll(async ()=>{
    const hostVis = await host.isVisible().catch(()=>false);
    const editorVis = await editor.isVisible().catch(()=>false);
    return hostVis || editorVis;
  }, {timeout: 6500}).toBe(true);

  const isMonaco = await page.evaluate(() => {
    try{ return !!(window as any).monacoEditor || !!(window as any).monaco; }catch{ return false; }
  });

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
  // Try Monaco first
  const hasMonaco = await page.evaluate(() => {
    try{ const ed=(window as any).monacoEditor; return !!ed && typeof ed.getValue==='function'; }catch{ return false; }
  });
  if(hasMonaco){
    await page.evaluate((c) => {
      try{
        const ed=(window as any).monacoEditor;
        if(ed){ ed.setValue(c); ed.focus(); }
      }catch{}
    }, code);
  } else {
    const ta = page.locator('#editor');
    await ta.fill(code);
  }
}

export async function selectLang(page: Page, lang: string){
  const sel = page.locator('#langSelect');
  if(await sel.isVisible()){
    await sel.selectOption(lang);
    await page.waitForTimeout(300);
  }
}

export async function selectQuestion(page: Page, slug: string){
  const qSel = page.locator('#questionSelect');
  if(await qSel.count() && await qSel.first().isVisible()){
    // If option exists select else try window hook
    try{
      await qSel.selectOption(slug);
    }catch{
      await page.evaluate((s)=>{
        try{
          const el=document.getElementById('questionSelect') as HTMLSelectElement;
          if(el){ el.value=s; el.dispatchEvent(new Event('change',{bubbles:true})); }
        }catch{}
      }, slug);
    }
    await page.waitForTimeout(400);
  } else {
    // Try to trigger via API/questions loaded widget
    await page.evaluate((s)=>{
      try{ localStorage.setItem('randori-last-question', s); }catch{}
    }, slug);
  }
}

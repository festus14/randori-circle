import { test, expect } from '@playwright/test';
import { setNoOnboarding, waitForMonacoOrFallback, apiLog, ensureCodeView } from './helpers';

test.describe('Monaco IDE resilient load', () => {
  test('loads Monaco or falls back gracefully without throw toast', async ({ page }) => {
    test.setTimeout(30000);
    await setNoOnboarding(page);

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('console', msg => {
      if(msg.type()==='error'){
        const txt=msg.text();
        if(txt.includes('window.toast is not a function')) pageErrors.push('console.error toast: '+txt.slice(0,200));
      }
    });

    await page.goto('/', { waitUntil:'domcontentloaded' });
    await ensureCodeView(page);
    // Give init 450ms + loader attempt
    await page.waitForTimeout(600);

    const { isMonaco } = await waitForMonacoOrFallback(page);

    const host = page.locator('#monacoHost');
    const editorTA = page.locator('#editor');
    const fallbackNote = page.locator('#monacoFallbackNote');
    const formatBtn = page.locator('#formatBtn');
    const retryBtn = page.locator('#monacoRetry');

    if(isMonaco){
      // Monaco path
      await expect(host).toBeVisible({ timeout: 7000 });
      const val = await page.evaluate(() => {
        try{
          const ed=(window as any).monacoEditor;
          if(ed) return ed.getValue().length;
          if((window as any).monaco) return 1;
          return 0;
        }catch{ return 0; }
      });
      expect(val).toBeGreaterThan(5);

      if(await formatBtn.count()){
        await expect(formatBtn.first()).toBeVisible();
      }

      // Theme toggle shouldn't throw
      const themeToggle = page.locator('#themeToggle');
      if(await themeToggle.count() && await themeToggle.isVisible()){
        await themeToggle.click();
        await page.waitForTimeout(300);
        // click back
        if(await themeToggle.isVisible()) await themeToggle.click().catch(()=>{});
      }

      // Ensure no toast crash
      expect(pageErrors.filter(e=> e.includes('window.toast is not a function')).length).toBe(0);
    } else {
      // Fallback path must be usable
      // fallback note visible (maybe) and textarea visible
      const fallbackVis = await fallbackNote.isVisible().catch(()=>false);
      const taVis = await editorTA.isVisible().catch(()=>false);
      // one of them must indicate fallback handled
      expect(fallbackVis || taVis).toBe(true);
      if(await retryBtn.isVisible().catch(()=>false)){
        // retry button presence is enough; click shouldn't crash
        await retryBtn.click().catch(()=>{});
      }
      // Log but don't fail on fallback -> should still be usable
      await apiLog(page, 'warn', 'monaco_fallback_detected_e2e', 'Monaco fallback triggered in e2e - acceptable if CDN slow', {isMonaco});
    }

    // Generic guard: page still functional
    const runBtn = page.locator('#runBtn');
    if(await runBtn.count()) await expect(runBtn.first()).toBeVisible();

    if(pageErrors.length){
      const bad = pageErrors.filter(e=> e.toLowerCase().includes('toast') || e.includes('monaco') && e.toLowerCase().includes('init error'));
      if(bad.length){
        await apiLog(page, 'error', 'e2e_fail', `monaco.spec pageerrors: ${bad.slice(0,3).join(' | ')}`, {spec:'monaco'});
      }
      expect(bad.length, `Unexpected Monaco/toast crashes: ${bad.join(' | ')}`).toBe(0);
    }
  });
});

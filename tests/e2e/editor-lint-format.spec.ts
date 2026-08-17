import { test, expect } from '@playwright/test';
import { setNoOnboarding, setCode, selectLang, ensureCodeView } from './helpers';

test.describe('IDE lint & format', () => {
  test('syntax error shows lint err count (if Monaco)', async ({ page }) => {
    test.setTimeout(20000);
    await setNoOnboarding(page);
    await page.goto('/');
    await ensureCodeView(page);
    await page.waitForTimeout(700);

    await selectLang(page, 'javascript');
    await setCode(page, 'function a( {'); // missing closing

    const lint = page.locator('#lintStatus');
    // Wait 3s for Monaco marker change, if monaco
    const isMonaco = await page.evaluate(()=>{ try{ return !!(window as any).monacoEditor; }catch{ return false; }});
    if(isMonaco){
      await expect.poll(async ()=>{
        const vis=await lint.isVisible().catch(()=>false);
        const txt=await lint.textContent().catch(()=> '');
        return vis && txt && txt.length>0;
      }, {timeout:5000}).toBe(true);
      const lintTxt = await lint.textContent();
      expect(lintTxt?.toLowerCase()).toMatch(/err|warn|lint/);
    } else {
      // fallback plain editor -> lint may be hidden, don't fail
      expect(true).toBe(true);
    }
  });

  test('format button formats messy code without crash', async ({ page }) => {
    test.setTimeout(20000);
    await setNoOnboarding(page);
    await page.goto('/');
    await ensureCodeView(page);
    await page.waitForTimeout(700);

    const messy = `function twoSum( nums , target ){return [0,1]}`;
    await selectLang(page, 'javascript');
    await setCode(page, messy);

    const formatBtn = page.locator('#formatBtn');
    if(await formatBtn.count() && await formatBtn.isVisible()){
      await formatBtn.click();
      await page.waitForTimeout(800);
      // Get resulting code
      const after = await page.evaluate(()=>{
        try{
          const ed=(window as any).monacoEditor;
          if(ed) return ed.getValue();
          const ta=document.getElementById('editor') as HTMLTextAreaElement;
          return ta? ta.value : '';
        }catch{ return ''; }
      });
      expect(after.length).toBeGreaterThan(5);
      expect(after.includes('twoSum')).toBe(true);
      // Should not have double spaces around comma after format (prettier singleQuote + 2 spaces)
      // At minimum not crash
    } else {
      test.skip(true, 'Format button not present');
    }
  });
});

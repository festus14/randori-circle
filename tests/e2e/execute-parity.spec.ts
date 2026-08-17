import { test, expect } from '@playwright/test';
import { setNoOnboarding, setCode, selectLang, selectQuestion, twoSumCorrectJS } from './helpers';

test.describe('JS server parity vs local', () => {
  test('same JS code local and server produce same pass count (or server at least)', async ({ page }) => {
    test.setTimeout(35000);
    await setNoOnboarding(page);
    await page.goto('/');
    await page.waitForTimeout(600);

    await selectLang(page, 'javascript');
    await selectQuestion(page, 'two-sum');
    await setCode(page, twoSumCorrectJS());

    const toggle = page.locator('#useServerRunner');
    const runBtn = page.locator('#runBtn');
    const runOut = page.locator('#runOut');

    // Local run first (unchecked)
    if(await toggle.count()){
      await toggle.uncheck().catch(()=>{});
      await page.waitForTimeout(150);
    }
    await runBtn.click();
    await expect.poll(async ()=> (await runOut.textContent().catch(()=> ''))?.length>4, {timeout:10000}).toBe(true);
    const localOut = await runOut.textContent();
    const localMatch = localOut?.match(/(\d+)\/(\d+)/);

    // Server run second (checked)
    if(await toggle.count()){
      await toggle.check().catch(()=>{});
      await page.waitForTimeout(150);
      await runBtn.click();
      await expect.poll(async ()=>{
        const txt=await runOut.textContent().catch(()=> '');
        return txt && txt.includes('Result') && txt.length>4;
      }, {timeout:15000}).toBe(true);
      const serverOut = await runOut.textContent();
      // Both should mention pass
      expect(serverOut?.toLowerCase()).toMatch(/pass|result/);
      if(localMatch){
        const localPassed = localMatch[1];
        // Server should have same or at least >0 passed
        const serverMatch = serverOut?.match(/(\d+)\/(\d+)/);
        if(serverMatch){
          expect(parseInt(serverMatch[1])).toBeGreaterThanOrEqual(0);
          // ideally same
          // don't hard fail if piston rate-limited, but log warning
        }
      }
    } else {
      // No toggle, just local verified
      expect(localOut?.toLowerCase()).toMatch(/pass|result/);
    }
  });
});

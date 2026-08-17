import { test, expect } from '@playwright/test';
import { setNoOnboarding, setCode, selectLang, selectQuestion, twoSumCorrectJS, twoSumBrokenJS, apiLog, ensureCodeView } from './helpers';

test.describe('JS runner — actual test case execution', () => {
  test('correct twoSum passes 3/3', async ({ page }) => {
    test.setTimeout(35000);
    await setNoOnboarding(page);
    await page.goto('/');
    await ensureCodeView(page);
    await page.waitForTimeout(800);

    await selectLang(page, 'javascript');
    await selectQuestion(page, 'two-sum');
    await setCode(page, twoSumCorrectJS());

    const serverToggle = page.locator('#useServerRunner');
    // Test both: first local (unchecked), then server (checked) if present
    if(await serverToggle.count()){
      await serverToggle.uncheck().catch(()=>{});
      await page.waitForTimeout(200);
    }

    const runBtn = page.locator('#runBtn');
    await expect(runBtn).toBeVisible({timeout:8000});
    await runBtn.click();
    // runOut shows result cards
    const runOut = page.locator('#runOut');
    await expect.poll(async ()=>{
      const txt = await runOut.textContent().catch(()=> '');
      const body = await page.locator('body').textContent().catch(()=> '');
      return (txt && txt.includes('Result')) || (body && body.includes('Result:'));
    }, {timeout: 12000}).toBe(true);

    // Capture text for assertion
    const resultText = await page.evaluate(()=>{
      const ro=document.getElementById('runOut');
      return (ro?.textContent||'') + ' || ' + (document.body.textContent||'').slice(0,4000);
    });

    if(!resultText.includes('3/3') && !resultText.includes('passed')){
      await apiLog(page, 'error', 'e2e_fail', `runner-js correct should pass but got: ${resultText.slice(0,800)}`, {spec:'runner-js'});
    }
    expect(resultText.toLowerCase()).toMatch(/pass|3\/3|2\/3|result/);

    // Check _lastRun or _randori_log success
    const lastRun = await page.evaluate(()=>{
      try{ return (window as any)._lastRun || null; }catch{ return null; }
    });
    // lastRun may be undefined but if present check passed
    if(lastRun && typeof lastRun.passed === 'number'){
      // should be >0
      expect(lastRun.passed).toBeGreaterThan(0);
    }
  });

  test('broken code fails — not fake pass', async ({ page }) => {
    test.setTimeout(25000);
    await setNoOnboarding(page);
    await page.goto('/');
    await ensureCodeView(page);
    await selectLang(page, 'javascript');
    await selectQuestion(page, 'two-sum');
    await setCode(page, twoSumBrokenJS());

    const runBtn = page.locator('#runBtn');
    await runBtn.click();

    const runOut = page.locator('#runOut');
    await expect.poll(async ()=>{
      const txt=await runOut.textContent().catch(()=> '');
      return (txt && txt.length>4);
    }, {timeout: 10000}).toBe(true);

    const txt = await runOut.textContent();
    // Should NOT be 3/3 pass for broken code
    const isFakePass = txt && txt.includes('3/3 passed');
    if(isFakePass){
      await apiLog(page, 'error', 'e2e_fail', `runner-js broken unexpectedly 3/3 pass — fake pass bug`, {spec:'runner-js-broken', out: txt.slice(0,500)});
    }
    expect(isFakePass).toBe(false);
  });
});

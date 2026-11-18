import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signRunAttestation } from '../../api/data.js';
import { createPairedCircle, json, openApp, startGoldenRuntime, withDatabase } from './golden-runtime';
import { openRoomPanel } from './helpers';

// Real production handlers and migration-runner database, no toolkit API mocks.
// Only synthetic shared evidence is seeded; no provider is contacted.
test('interviewer privately scores, writes notes, decides, plays and downloads; candidate endpoints and projections reveal nothing',async({browser})=>{
  test.setTimeout(180_000);
  const flags=['INTERVIEW_SESSION_ENABLED','INTERVIEWER_TOOLKIT_ENABLED','PROGRESS_DASHBOARD_ENABLED'];
  const before=Object.fromEntries(flags.map(flag=>[flag,process.env[flag]]));
  for(const flag of flags)process.env[flag]='true';
  const golden=await startGoldenRuntime('randori-toolkit-e2e-465-');
  try{
    const pair=await createPairedCircle(browser,golden,{memberEmail:'toolkit.member@example.test',memberName:'Toolkit Member'});
    const ownerRole=await json(pair.owner.page,`/api/session-controls?room_id=${pair.room}`);
    expect(ownerRole.status,JSON.stringify(ownerRole.body)).toBe(200);
    const interviewer=ownerRole.body.session_controls.viewer_role==='interviewer'?pair.owner:pair.member;
    const candidate=interviewer===pair.owner?pair.member:pair.owner;
    const match=/^week_(\d+)_pair_(\d+)$/.exec(pair.room)!;
    const weekId=Number(match[1]),pairGroupId=Number(match[2]);
    await withDatabase(golden,async db=>{
      const code='// shared checkpoint evolution\nreturn 42;';
      await db.execute({sql:`INSERT INTO pair_room_snapshots(room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by) VALUES(?,?,?,1,3,'e2e-checkpoint',1,'javascript','focus-block-rollup@1',?,?)`,args:[pair.room,weekId,pairGroupId,JSON.stringify({code,board:{shapes:[]}}),interviewer.user.id]});
      for(const [index,code] of ['// shared code evolution one','// shared code evolution two'].entries()){
        const fields={userId:candidate.user.id,weekId,pairGroupId,questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript',
          codeHash:createHash('sha256').update(code).digest('hex'),documentRevision:index+1,documentStateHash:'a'.repeat(64),documentVersion:'b'.repeat(64),passedCount:index+1,totalCount:2,resultsJson:'[]'};
        const signed=signRunAttestation(fields);
        const snapshot={private_stdin:'PRIVATE_STDIN_SENTINEL',source:'original-catalog',version:1,total_count:2,attestation_version:3,attestation_key_id:signed.keyId,attestation:signed.signature,
          week_id:weekId,pair_group_id:pairGroupId,code_hash:fields.codeHash,document_revision:fields.documentRevision,document_state_hash:fields.documentStateHash,document_version:fields.documentVersion};
        await db.execute({sql:`INSERT INTO session_runs(user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
          VALUES(?,?,?,'focus-block-rollup','javascript',?,?,'[]',?,2,10,datetime('now',?))`,args:[candidate.user.id,weekId,pairGroupId,code,JSON.stringify(snapshot),index+1,`-${2-index} minutes`]});
      }
    });
    for(const action of ['admit','end']){
      const controls=await json(interviewer.page,`/api/session-controls?room_id=${pair.room}`);
      const transitioned=await json(interviewer.page,'/api/session-controls','POST',{room_id:pair.room,action,base_version:controls.body.session_controls.version});
      expect(transitioned.status,JSON.stringify(transitioned.body)).toBe(200);
    }
    const loaded:string[]=[];interviewer.page.on('request',request=>{if(request.url().includes('/assets/interviewer-toolkit.js'))loaded.push(request.url());});
    await openApp(interviewer.page,golden,`/join/${pair.room}`);
    await openApp(candidate.page,golden,`/join/${pair.room}`);
    await openRoomPanel(interviewer.page,'session');await openRoomPanel(candidate.page,'session');
    await expect(interviewer.page.getByTestId('toolkit-open')).toBeVisible();
    await expect(candidate.page.getByTestId('toolkit-open')).toBeHidden();
    expect(loaded).toHaveLength(0);
    await interviewer.page.getByTestId('toolkit-open').click();
    const panel=interviewer.page.getByTestId('interviewer-toolkit');await expect(panel).toBeVisible();
    await expect(interviewer.page.getByTestId('toolkit-form')).toBeVisible();expect(loaded).toHaveLength(1);
    await interviewer.page.locator('#toolkit-problem_solving').selectOption('4');
    await interviewer.page.locator('#toolkit-communication').selectOption('3');
    await interviewer.page.locator('#toolkit-code_quality').selectOption('2');
    await interviewer.page.locator('#toolkit-testing').selectOption('1');
    const privateNote='PRIVATE_TOOLKIT_SENTINEL <script>never execute</script>';
    await interviewer.page.getByTestId('toolkit-notes').fill(privateNote);
    await interviewer.page.getByTestId('toolkit-decision').selectOption('strong_hire');
    await interviewer.page.getByTestId('toolkit-save').click();
    await expect(interviewer.page.getByTestId('toolkit-status')).toHaveText('Private evaluation saved.');
    await expect(interviewer.page.getByTestId('toolkit-insights')).toContainText('1 evaluated');
    await expect(interviewer.page.getByTestId('toolkit-timeline')).toContainText('Run');
    await interviewer.page.getByTestId('toolkit-timeline').getByRole('button').filter({hasText:'1/2 passed'}).click();
    await expect(interviewer.page.getByTestId('toolkit-playback-code')).toHaveText('// shared code evolution one');
    await interviewer.page.getByTestId('toolkit-timeline').getByRole('button').filter({hasText:'2/2 passed'}).click();
    await expect(interviewer.page.getByTestId('toolkit-playback-code')).toHaveText('// shared code evolution two');
    await expect(interviewer.page.getByTestId('toolkit-retention')).toContainText('Editing does not extend');
    const violations=await new AxeBuilder({page:interviewer.page}).include('[data-testid="interviewer-toolkit"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(violations.violations).toEqual([]);
    const downloaded=interviewer.page.waitForEvent('download');await interviewer.page.getByTestId('toolkit-download').click();
    const download=await downloaded;expect(download.suggestedFilename()).toBe(`randori-interview-${pair.room}.json`);
    const text=await readFile((await download.path())!,'utf8'),archive=JSON.parse(text);
    expect(archive.phase).toBe('ended');
    expect(archive.timeline.some(event=>event.kind==='phase'&&event.phase==='live')).toBe(true);
    expect(archive.timeline.some(event=>event.kind==='phase'&&event.phase==='ended')).toBe(true);
    expect(archive.evaluation).toMatchObject({revision:1,notes:privateNote,decision:'strong_hire',rubric:{problem_solving:4,communication:3,code_quality:2,testing:1}});
    expect(text).not.toContain('PRIVATE_STDIN_SENTINEL');expect(text).not.toContain('test_cases_snapshot');
    expect((await json(candidate.page,`/api/interviewer-toolkit?room_id=${pair.room}`))).toEqual({status:404,body:{error:'pair not found'}});
    const denied=await json(candidate.page,'/api/interviewer-toolkit','POST',{room_id:pair.room,revision:1,rubric:archive.evaluation.rubric,notes:'forged',decision:'hire'});
    expect(denied).toEqual({status:404,body:{error:'pair not found'}});
    for(const path of [`/api/pair-recap?room_id=${pair.room}`,`/api/messages?room_id=${pair.room}`,'/api/history','/api/progress',`/api/runs?week_id=${weekId}&pair_group_id=${pairGroupId}`]){
      const response=await json(candidate.page,path);expect(response.status,`${path} ${JSON.stringify(response.body)}`).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(privateNote);expect(JSON.stringify(response.body)).not.toContain('strong_hire');
    }
    await panel.getByRole('button',{name:'Close',exact:true}).click();
    await interviewer.page.locator('[data-tab="history"]').click();
    await expect(interviewer.page.getByTestId('toolkit-history')).toBeVisible();
    await interviewer.page.getByTestId('toolkit-history').click();await expect(interviewer.page.getByTestId('toolkit-notes')).toHaveValue(privateNote);
    await interviewer.page.getByTestId('interviewer-toolkit').getByRole('button',{name:'Close',exact:true}).click();
    await candidate.page.locator('[data-tab="history"]').click();await expect(candidate.page.getByTestId('toolkit-history')).toHaveCount(0);
    await withDatabase(golden,async db=>{expect((await db.execute('SELECT COUNT(*) AS n FROM ai_sessions')).rows[0].n).toBe(0);});
  }finally{await golden.close();for(const flag of flags){if(before[flag]===undefined)delete process.env[flag];else process.env[flag]=before[flag];}}
});

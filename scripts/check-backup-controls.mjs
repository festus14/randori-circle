#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const REHEARSAL_PATH='.github/workflows/turso-backup-restore-rehearsal.yml';
const WATCHDOG_PATH='.github/workflows/turso-backup-restore-watchdog.yml';
const DEPLOYABILITY_PATH='.github/workflows/deployability.yml';
const WORKFLOW_DIGESTS=Object.freeze({
  rehearsal:'4689edfeeb154ab1682bd4856a312ba9041315bedf98e658ed2a4029dbf93229',
  watchdog:'d635165fe7b0ee986c10852583d16d440839388cc4dfdc17516998aa80d35df8',
  deployability:'e81983931c58b9abcaea6569a40967b38346ce3c4923ea14f41d6eabf75da503',
});
const PROTECTED_REHEARSAL_RUN=[
  '        run: |',
  '          timeout --signal=TERM --kill-after=3m 28m \\',
  '            node scripts/turso-backup-restore-rehearsal.mjs \\',
  '            --mode run \\',
  '            --artifact-dir "${RUNNER_TEMP}/public-artifacts" \\',
  '            --state-file "${RUNNER_TEMP}/private-recovery/state.json"',
].join('\n');
const CLEANUP_RUN=[
  '        run: |',
  '          timeout --signal=TERM --kill-after=30s 6m \\',
  '            node scripts/turso-backup-restore-rehearsal.mjs \\',
  '            --mode cleanup \\',
  '            --artifact-dir "${RUNNER_TEMP}/public-artifacts" \\',
  '            --state-file "${RUNNER_TEMP}/private-recovery/state.json"',
].join('\n');
const MONITOR_RUN=[
  '        run: |',
  '          node scripts/turso-backup-restore-monitor.mjs \\',
  '            --rehearsal-summary "${RUNNER_TEMP}/public-artifacts/rehearsal-summary.json" \\',
  '            --cleanup-summary "${RUNNER_TEMP}/public-artifacts/cleanup-summary.json" \\',
  '            --output "${RUNNER_TEMP}/public-artifacts/backup-monitor-summary.json"',
].join('\n');
const REHEARSAL_ALERT_RUN=[
  '        run: |',
  '          echo "::error title=Backup restore monitor alert::Category ${ALERT_CATEGORY}. Follow the backup restore runbook and inspect only sanitized artifacts."',
  '          exit 1',
].join('\n');
const WATCHDOG_ALERT_RUN=[
  '        run: |',
  '          echo "::error title=Backup restore watchdog alert for @festus14::Category ${ALERT_CATEGORY}. Follow the backup restore runbook; no production credential is available to this watchdog."',
  '          exit 1',
].join('\n');

function uncomment(source){
  return String(source??'').split('\n').map(line=>{
    let single=false;
    let double=false;
    for(let index=0;index<line.length;index+=1){
      const character=line[index];
      if(character==="'"&&!double) single=!single;
      if(character==='"'&&!single&&line[index-1]!=="\\") double=!double;
      if(character==='#'&&!single&&!double&&(index===0||/\s/.test(line[index-1]))){
        return line.slice(0,index).trimEnd();
      }
    }
    return line.trimEnd();
  }).join('\n');
}

function block(source,heading,indentation=0){
  const lines=source.split('\n');
  const prefix=' '.repeat(indentation);
  const start=lines.findIndex(line=>line===`${prefix}${heading}:`);
  if(start<0) return '';
  let end=lines.length;
  for(let index=start+1;index<lines.length;index+=1){
    if(!lines[index].trim()) continue;
    const indentationAtLine=lines[index].length-lines[index].trimStart().length;
    if(indentationAtLine<=indentation){ end=index; break; }
  }
  return lines.slice(start,end).join('\n').trimEnd();
}

function directKeys(source,indentation){
  const prefix=' '.repeat(indentation);
  return [...source.matchAll(new RegExp(`^${prefix}([A-Za-z0-9_-]+):(?:[ \\t].*)?$`,'gm'))]
    .map(match=>match[1]);
}

function safeYamlSubset(source){
  return !/^\s*(?:['"][^'"]+['"]|\?|<<)\s*:/m.test(source)
    &&!/^\s*(?:-[ \t]*)?[?:](?:[ \t]|$)/m.test(source)
    &&!/^\s*(?:-[ \t]*)?(?:&(?!&)|\*(?!\*)|!(?!=))/m.test(source)
    &&!/^\s*[A-Za-z0-9_-]+[ \t]+:/m.test(source)
    &&!/^\s*[^#\n]+:\s*[&!]/m.test(source)
    &&!source.includes('\t');
}

function exactKeys(source,heading,indentation,expected){
  const values=directKeys(block(source,heading,indentation),indentation+2).sort();
  return JSON.stringify(values)===JSON.stringify([...expected].sort());
}

function exactDirectKeys(source,indentation,expected){
  const values=directKeys(source,indentation).sort();
  return JSON.stringify(values)===JSON.stringify([...expected].sort());
}

function exactEnvironment(source,expected){
  return exactDirectKeys(block(source,'env',8),10,expected);
}

function exactEnvironmentBlock(source,expectedLines){
  return block(source,'env',8)===[
    '        env:',...expectedLines.map(line=>`          ${line}`),
  ].join('\n');
}

function environmentValue(source,key){
  return field(block(source,'env',8),key,10);
}

function step(source,name){
  const marker=`      - name: ${name}`;
  const start=source.indexOf(marker);
  if(start<0) return '';
  const remainder=source.slice(start+marker.length);
  const next=/\n      - /.exec(remainder);
  return source.slice(start,next===null?source.length:start+marker.length+next.index);
}

function field(source,key,indentation){
  const lines=source.split('\n');
  const prefix=' '.repeat(indentation);
  const start=lines.findIndex(line=>line.startsWith(`${prefix}${key}:`));
  if(start<0) return '';
  let end=start+1;
  if(/:\s*(?:[>|][-+]?)$/.test(lines[start])){
    for(;end<lines.length;end+=1){
      if(!lines[end].trim()) continue;
      const current=lines[end].length-lines[end].trimStart().length;
      if(current<=indentation) break;
    }
  }
  return lines.slice(start,end).join('\n').trimEnd();
}

function actionsAreExact(source,expected){
  const actions=[...source.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*([^\s]+)[ \t]*$/gm)]
    .map(match=>match[1]);
  return actions.every(action=>/@[a-f0-9]{40}$/.test(action))
    &&JSON.stringify(actions)===JSON.stringify(expected);
}

function stepHeaders(source){
  return [...source.matchAll(/^      - ([^:\n]+):[ \t]*(.*?)[ \t]*$/gm)]
    .map(match=>`${match[1]}:${match[2]}`);
}

function checkoutIsSafe(source,name){
  const value=step(source,name);
  const lines=value.split('\n');
  const withIndex=lines.indexOf('        with:');
  const inputs={};
  if(withIndex>=0){
    for(const line of lines.slice(withIndex+1)){
      if(!line.trim()) continue;
      const indentation=line.length-line.trimStart().length;
      if(indentation<=8) break;
      const input=/^          ([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
      if(input) inputs[input[1]]=input[2];
    }
  }
  return /^[ \t]*uses:[ \t]*actions\/checkout@[a-f0-9]{40}[ \t]*$/m.test(value)
    &&inputs['persist-credentials']==='false';
}

function unnamedCheckoutIsSafe(source){
  const marker=/^      - uses: actions\/checkout@[a-f0-9]{40}[ \t]*$/m.exec(source);
  if(!marker) return false;
  const start=marker.index;
  const remainder=source.slice(start+marker[0].length);
  const next=/\n      - /.exec(remainder);
  const value=source.slice(start,next===null?source.length:start+marker[0].length+next.index);
  const lines=value.split('\n');
  const withIndex=lines.indexOf('        with:');
  if(withIndex<0) return false;
  const inputs={};
  for(const line of lines.slice(withIndex+1)){
    if(!line.trim()) continue;
    const indentation=line.length-line.trimStart().length;
    if(indentation<=8) break;
    const input=/^          ([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if(input) inputs[input[1]]=input[2];
  }
  return JSON.stringify(Object.keys(inputs).sort())===JSON.stringify(['persist-credentials'])
    &&inputs['persist-credentials']==='false';
}

function artifactPaths(source){
  return [...source.matchAll(/^\s+path:\s*(.*?)\s*$/gm)].map(match=>match[1]);
}

function secretNames(source){
  return [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)]
    .map(match=>match[1]);
}

function hasSecretAccess(source){
  return /\bsecrets\b/i.test(source);
}

function exactSecretPlacement(source,contracts){
  let remainder=source;
  for(const [name,expected] of contracts){
    const value=step(source,name);
    if(!value) return false;
    const names=secretNames(value).sort();
    const accesses=(value.match(/\bsecrets\b/gi)||[]).length;
    if(accesses!==names.length) return false;
    if(JSON.stringify(names)!==JSON.stringify([...expected].sort())) return false;
    remainder=remainder.replace(value,'');
  }
  return !hasSecretAccess(remainder);
}

function add(errors,condition,message){
  if(!condition&&!errors.includes(message)) errors.push(message);
}

function exactWorkflowBytes(source,expectedDigest){
  return createHash('sha256').update(String(source??''),'utf8').digest('hex')===expectedDigest;
}

function validateRehearsal(raw){
  const source=uncomment(raw);
  const errors=[];
  add(errors,exactWorkflowBytes(raw,WORKFLOW_DIGESTS.rehearsal),
    'rehearsal workflow bytes must match the reviewed contract');
  add(errors,safeYamlSubset(source),
    'rehearsal workflow must use the reviewed unambiguous YAML subset');
  add(errors,exactDirectKeys(source,0,['name','on','permissions','concurrency','jobs']),
    'rehearsal workflow must contain only the reviewed top-level controls');
  add(errors,exactKeys(source,'on',0,['schedule','workflow_dispatch']),
    'rehearsal triggers must be schedule and workflow_dispatch only');
  add(errors,(block(source,'on',0).match(/^\s{4}- cron:[^\n]+$/gm)||[]).length===1
    &&/^\s{4}- cron: '17 3 \* \* 1'\s*$/m.test(block(source,'on',0)),
    'rehearsal cadence must remain Monday 03:17 UTC');
  add(errors,exactKeys(source,'jobs',0,['rehearse']),
    'rehearsal workflow must contain only the reviewed rehearse job');
  add(errors,exactDirectKeys(block(source,'rehearse',2),4,
    ['if','environment','runs-on','timeout-minutes','steps']),
  'rehearsal job fields must match the reviewed protected contract');
  add(errors,JSON.stringify(stepHeaders(source))===JSON.stringify([
    'name:Check out the latest default branch',
    'name:Refuse a stale main checkout',
    'uses:actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'name:Install locked dependencies',
    'name:Run protected PITR rehearsal',
    'name:Restore source state and clean disposable restore',
    'name:Upload sanitized cleanup summary',
    'name:Evaluate backup freshness and restore evidence',
    'name:Upload sanitized backup monitor summary',
    'name:Upload signed rehearsal attestation',
    'name:Alert on missing, stale, corrupt, failed, or unclean evidence',
  ]),'rehearsal steps must match the reviewed fail-closed sequence');
  add(errors,exactKeys(source,'permissions',0,['contents'])
    &&/^\s{2}contents:\s*read\s*$/m.test(block(source,'permissions',0))
    &&!/^\s{4,}permissions:/m.test(source),
  'rehearsal permissions must be contents: read only');
  add(errors,/^\s{2}group:\s*turso-production-database-operations\s*$/m
    .test(block(source,'concurrency',0))
    &&/^\s{2}cancel-in-progress:\s*false\s*$/m.test(block(source,'concurrency',0)),
  'rehearsal must share the non-cancelling production database lock');
  add(errors,field(block(source,'rehearse',2),'if',4)===`    if: >-
      github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
      && (github.event_name == 'schedule'
      || inputs.confirmation == 'RESTORE_DISPOSABLE_ONLY')`,
  'rehearsal job must fail closed to default-branch schedule or exact manual confirmation');
  add(errors,field(block(source,'rehearse',2),'environment',4)===
    '    environment: turso-migration-rehearsal',
    'rehearsal must use the protected migration-rehearsal environment');
  add(errors,/^\s{4}timeout-minutes:\s*90\s*$/m.test(source),
    'rehearsal job must retain its bounded timeout');
  add(errors,checkoutIsSafe(source,'Check out the latest default branch'),
    'rehearsal checkout must be SHA-pinned and persist no credentials');
  add(errors,actionsAreExact(source,[
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]),'rehearsal external actions must match the immutable reviewed allowlist');
  add(errors,!/\bcontinue-on-error\s*:/i.test(source),
    'rehearsal must not continue after a failed safety step');

  add(errors,exactSecretPlacement(source,[
    ['Run protected PITR rehearsal',[
      'MIGRATION_DIGEST_HMAC_KEY','TURSO_PRODUCTION_PLATFORM_TOKEN',
    ]],
    ['Restore source state and clean disposable restore',['TURSO_PRODUCTION_PLATFORM_TOKEN']],
    ['Evaluate backup freshness and restore evidence',['MIGRATION_DIGEST_HMAC_KEY']],
  ]),
  'rehearsal secret exposure must stay limited to the run, cleanup, and monitor contract');
  const rehearsalRun=step(source,'Run protected PITR rehearsal');
  add(errors,exactDirectKeys(rehearsalRun,8,['id','timeout-minutes','env','run'])
    &&field(rehearsalRun,'run',8)===PROTECTED_REHEARSAL_RUN,
  'protected rehearsal command must match the reviewed bounded runner invocation');
  add(errors,exactEnvironmentBlock(rehearsalRun,[
    "RESTORE_REHEARSAL_CONFIRM: ${{ github.event_name == 'schedule' && 'RESTORE_DISPOSABLE_ONLY' || inputs.confirmation }}",
    'REHEARSAL_WORKFLOW_PATH: .github/workflows/turso-backup-restore-rehearsal.yml',
    'REHEARSAL_GITHUB_ENVIRONMENT: turso-migration-rehearsal',
    'TURSO_ORGANIZATION: ${{ vars.TURSO_ORGANIZATION }}',
    'TURSO_GROUP: ${{ vars.TURSO_GROUP }}',
    'TURSO_PRODUCTION_DATABASE_NAME: ${{ vars.TURSO_PRODUCTION_DATABASE_NAME }}',
    'TURSO_PRODUCTION_DATABASE_ID: ${{ vars.TURSO_PRODUCTION_DATABASE_ID }}',
    'TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES: ${{ vars.TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES }}',
    'TURSO_RESTORE_DATABASE_PREFIX: ${{ vars.TURSO_RESTORE_DATABASE_PREFIX }}',
    'TURSO_PRODUCTION_PLATFORM_TOKEN: ${{ secrets.TURSO_PRODUCTION_PLATFORM_TOKEN }}',
    'MIGRATION_DIGEST_HMAC_KEY: ${{ secrets.MIGRATION_DIGEST_HMAC_KEY }}',
    "TURSO_PLATFORM_TIMEOUT_MS: '15000'",
    "TURSO_DATABASE_TIMEOUT_MS: '30000'",
    'REHEARSAL_MAX_SNAPSHOT_AGE_MS: ${{ vars.REHEARSAL_MAX_SNAPSHOT_AGE_MS }}',
    'REHEARSAL_MAX_EVIDENCE_AGE_MS: ${{ vars.REHEARSAL_MAX_EVIDENCE_AGE_MS }}',
    "REHEARSAL_RPO_TARGET_MS: '1800000'",
    "REHEARSAL_RTO_TARGET_MS: '900000'",
    "REHEARSAL_POLL_ATTEMPTS: '60'",
    "REHEARSAL_POLL_INTERVAL_MS: '5000'",
    "REHEARSAL_POLL_DURATION_MS: '300000'",
    "REHEARSAL_CLEANUP_POLL_ATTEMPTS: '12'",
    "REHEARSAL_CLEANUP_POLL_INTERVAL_MS: '2000'",
    "REHEARSAL_CLEANUP_POLL_DURATION_MS: '120000'",
    "REHEARSAL_EVIDENCE_DURATION_MS: '300000'",
  ])&&environmentValue(rehearsalRun,'REHEARSAL_RPO_TARGET_MS')===
      "          REHEARSAL_RPO_TARGET_MS: '1800000'"
    &&environmentValue(rehearsalRun,'REHEARSAL_RTO_TARGET_MS')===
      "          REHEARSAL_RTO_TARGET_MS: '900000'",
  'rehearsal and monitor must retain the fixed 30-minute RPO and 15-minute RTO');

  const cleanup=step(source,'Restore source state and clean disposable restore');
  add(errors,exactDirectKeys(cleanup,8,['id','if','timeout-minutes','env','run'])
    &&exactEnvironmentBlock(cleanup,[
      'TURSO_ORGANIZATION: ${{ vars.TURSO_ORGANIZATION }}',
      'TURSO_GROUP: ${{ vars.TURSO_GROUP }}',
      'TURSO_PRODUCTION_DATABASE_NAME: ${{ vars.TURSO_PRODUCTION_DATABASE_NAME }}',
      'TURSO_PRODUCTION_DATABASE_ID: ${{ vars.TURSO_PRODUCTION_DATABASE_ID }}',
      'TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES: ${{ vars.TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES }}',
      'TURSO_RESTORE_DATABASE_PREFIX: ${{ vars.TURSO_RESTORE_DATABASE_PREFIX }}',
      'TURSO_PRODUCTION_PLATFORM_TOKEN: ${{ secrets.TURSO_PRODUCTION_PLATFORM_TOKEN }}',
      "TURSO_PLATFORM_TIMEOUT_MS: '15000'",
      "REHEARSAL_CLEANUP_POLL_ATTEMPTS: '12'",
      "REHEARSAL_CLEANUP_POLL_INTERVAL_MS: '2000'",
      "REHEARSAL_CLEANUP_POLL_DURATION_MS: '120000'",
    ])
    &&field(cleanup,'if',8)===
    "        if: always() && steps.source.outcome == 'success' && steps.install.outcome == 'success'"
    &&field(cleanup,'run',8)===CLEANUP_RUN,
  'rehearsal must always run bounded source-state and disposable-restore cleanup');
  const monitor=step(source,'Evaluate backup freshness and restore evidence');
  add(errors,exactDirectKeys(monitor,8,['id','if','timeout-minutes','env','run'])
    &&exactEnvironmentBlock(monitor,[
      'REHEARSAL_WORKFLOW_PATH: .github/workflows/turso-backup-restore-rehearsal.yml',
      'REHEARSAL_GITHUB_ENVIRONMENT: turso-migration-rehearsal',
      'TURSO_GROUP: ${{ vars.TURSO_GROUP }}',
      'TURSO_PRODUCTION_DATABASE_NAME: ${{ vars.TURSO_PRODUCTION_DATABASE_NAME }}',
      'TURSO_PRODUCTION_DATABASE_ID: ${{ vars.TURSO_PRODUCTION_DATABASE_ID }}',
      'MIGRATION_DIGEST_HMAC_KEY: ${{ secrets.MIGRATION_DIGEST_HMAC_KEY }}',
      'REHEARSAL_MAX_EVIDENCE_AGE_MS: ${{ vars.REHEARSAL_MAX_EVIDENCE_AGE_MS }}',
      "REHEARSAL_RPO_TARGET_MS: '1800000'",
      "REHEARSAL_RTO_TARGET_MS: '900000'",
      "BACKUP_MONITOR_MAX_SUCCESS_AGE_MS: '1800000'",
    ])
    &&environmentValue(monitor,'REHEARSAL_RPO_TARGET_MS')===
      "          REHEARSAL_RPO_TARGET_MS: '1800000'"
    &&environmentValue(monitor,'REHEARSAL_RTO_TARGET_MS')===
      "          REHEARSAL_RTO_TARGET_MS: '900000'"
    &&field(monitor,'if',8)===
    "        if: always() && steps.source.outcome == 'success' && steps.install.outcome == 'success'"
    &&field(monitor,'run',8)===MONITOR_RUN,
  'rehearsal must always evaluate sanitized recovery evidence after installation');
  const signedUpload=step(source,'Upload signed rehearsal attestation');
  add(errors,exactDirectKeys(signedUpload,8,['if','timeout-minutes','uses','with'])
    &&field(signedUpload,'if',8)===`        if: >-
          always() && steps.rehearsal.outcome == 'success'
          && steps.cleanup.outcome == 'success'
          && steps.cleanup_upload.outcome == 'success'
          && steps.monitor.outcome == 'success'
          && steps.monitor.outputs.alert == 'false'`,
  'signed rehearsal evidence must require cleanup, upload, and healthy monitor success');
  const alert=step(source,'Alert on missing, stale, corrupt, failed, or unclean evidence');
  add(errors,exactDirectKeys(alert,8,['if','shell','env','run'])
    &&field(alert,'if',8)===`        if: >-
          always() && (steps.monitor.outcome != 'success'
          || steps.monitor.outputs.alert != 'false')`
    &&field(alert,'run',8)===REHEARSAL_ALERT_RUN,
  'rehearsal monitor failures must end in an explicit terminal alert');

  const paths=artifactPaths(source).sort();
  const expectedPaths=[
    '${{ runner.temp }}/public-artifacts/backup-monitor-summary.json',
    '${{ runner.temp }}/public-artifacts/cleanup-summary.json',
    '${{ runner.temp }}/public-artifacts/rehearsal-summary.json',
  ].sort();
  add(errors,JSON.stringify(paths)===JSON.stringify(expectedPaths)
    &&!paths.some(value=>/private-recovery|state\.json/i.test(value)),
  'rehearsal uploads must use only the three sanitized public artifacts');
  for(const name of ['Upload sanitized cleanup summary','Upload sanitized backup monitor summary',
    'Upload signed rehearsal attestation']){
    add(errors,field(step(source,name),'retention-days',10)===
      '          retention-days: 30','rehearsal artifact retention must remain 30 days');
    add(errors,field(step(source,name),'if-no-files-found',10)===
      '          if-no-files-found: error',
    'rehearsal sanitized uploads must fail when their expected artifact is absent');
  }
  return errors;
}

function validateWatchdog(raw){
  const source=uncomment(raw);
  const errors=[];
  add(errors,exactWorkflowBytes(raw,WORKFLOW_DIGESTS.watchdog),
    'watchdog workflow bytes must match the reviewed contract');
  add(errors,safeYamlSubset(source),
    'watchdog workflow must use the reviewed unambiguous YAML subset');
  add(errors,exactDirectKeys(source,0,['name','on','permissions','concurrency','jobs']),
    'watchdog workflow must contain only the reviewed top-level controls');
  add(errors,exactKeys(source,'on',0,['schedule','workflow_dispatch']),
    'watchdog triggers must be schedule and workflow_dispatch only');
  add(errors,(block(source,'on',0).match(/^\s{4}- cron:[^\n]+$/gm)||[]).length===1
    &&/^\s{4}- cron: '47 \* \* \* \*'\s*$/m.test(block(source,'on',0)),
    'watchdog cadence must remain hourly at minute 47');
  add(errors,exactKeys(source,'jobs',0,['watchdog']),
    'watchdog workflow must contain only the reviewed watchdog job');
  add(errors,exactDirectKeys(block(source,'watchdog',2),4,
    ['if','runs-on','timeout-minutes','steps']),
  'watchdog job fields must match the reviewed read-only contract');
  add(errors,JSON.stringify(stepHeaders(source))===JSON.stringify([
    'name:Check out the latest default branch',
    'name:Use the supported Node runtime',
    'name:Discover authoritative scheduled rehearsal evidence',
    'name:Download authoritative monitor artifact',
    'name:Verify downloaded monitor evidence',
    'name:Upload sanitized watchdog evidence',
    'name:Alert the accountable backup owner',
  ]),'watchdog steps must match the reviewed read-only sequence');
  add(errors,exactKeys(source,'permissions',0,['actions','contents'])
    &&/^\s{2}actions:\s*read\s*$/m.test(block(source,'permissions',0))
    &&/^\s{2}contents:\s*read\s*$/m.test(block(source,'permissions',0))
    &&!/^\s{4,}permissions:/m.test(source),
  'watchdog permissions must be actions: read and contents: read only');
  add(errors,/^\s{2}group:\s*turso-backup-restore-watchdog\s*$/m
    .test(block(source,'concurrency',0))
    &&/^\s{2}cancel-in-progress:\s*false\s*$/m.test(block(source,'concurrency',0)),
  'watchdog must use its independent non-cancelling lock');
  add(errors,field(block(source,'watchdog',2),'if',4)===
    "    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    'watchdog must inspect only the default branch');
  add(errors,field(block(source,'watchdog',2),'timeout-minutes',4)===
    '    timeout-minutes: 20','watchdog job must retain its bounded timeout');
  add(errors,checkoutIsSafe(source,'Check out the latest default branch'),
    'watchdog checkout must be SHA-pinned and persist no credentials');
  add(errors,actionsAreExact(source,[
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]),'watchdog external actions must match the immutable reviewed allowlist');
  add(errors,!/^\s{4}environment:/m.test(source)&&!hasSecretAccess(source)
    &&!/TURSO_PRODUCTION_PLATFORM_TOKEN|MIGRATION_DIGEST_HMAC_KEY/.test(source),
  'watchdog must not receive a protected environment or provider/application secrets');
  add(errors,/^\s{10}GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\s*$/m.test(source),
    'watchdog must use only the read-only GitHub token');
  const discovery=step(source,'Discover authoritative scheduled rehearsal evidence');
  const verification=step(source,'Verify downloaded monitor evidence');
  add(errors,exactEnvironment(discovery,[
    'GITHUB_TOKEN','WATCHDOG_DEFAULT_BRANCH','WATCHDOG_CONTROL_ACTIVATION_AT',
    'WATCHDOG_MAX_RUN_AGE_MS',
    'WATCHDOG_STUCK_AFTER_MS','WATCHDOG_SLOT_GRACE_MS','WATCHDOG_SLOT_DEADLINE_MS',
  ])&&environmentValue(discovery,'WATCHDOG_MAX_RUN_AGE_MS')===
      "          WATCHDOG_MAX_RUN_AGE_MS: '691200000'"
    &&environmentValue(discovery,'WATCHDOG_STUCK_AFTER_MS')===
      "          WATCHDOG_STUCK_AFTER_MS: '5400000'"
    &&environmentValue(discovery,'WATCHDOG_SLOT_GRACE_MS')===
      "          WATCHDOG_SLOT_GRACE_MS: '7200000'"
    &&environmentValue(discovery,'WATCHDOG_SLOT_DEADLINE_MS')===
      "          WATCHDOG_SLOT_DEADLINE_MS: '12600000'"
    &&exactEnvironment(verification,['WATCHDOG_CONTROL_ACTIVATION_AT','WATCHDOG_MAX_RUN_AGE_MS'])
    &&environmentValue(verification,'WATCHDOG_CONTROL_ACTIVATION_AT')===
      "          WATCHDOG_CONTROL_ACTIVATION_AT: '2026-09-21T03:17:00.000Z'"
    &&environmentValue(verification,'WATCHDOG_MAX_RUN_AGE_MS')===
      "          WATCHDOG_MAX_RUN_AGE_MS: '691200000'",
  'watchdog freshness, stuck-run, grace, and absolute-deadline policy must remain fixed');
  add(errors,environmentValue(discovery,'WATCHDOG_CONTROL_ACTIVATION_AT')===
      "          WATCHDOG_CONTROL_ACTIVATION_AT: '2026-09-21T03:17:00.000Z'",
  'watchdog activation must remain the reviewed first Monday rehearsal slot');
  add(errors,!/turso-backup-restore-rehearsal\.mjs|gh\s+workflow\s+run|\/dispatches\b/.test(source),
    'watchdog must never dispatch or execute the protected provider rehearsal');
  add(errors,!/\bcontinue-on-error\s*:/i.test(source),
    'watchdog must not continue after a failed control step');
  add(errors,JSON.stringify(artifactPaths(step(source,'Upload sanitized watchdog evidence')))
    ===JSON.stringify([
    '${{ runner.temp }}/backup-watchdog-summary.json',
  ])&&!/path:[^\n]*(?:private-recovery|state\.json)/i.test(source),
  'watchdog must upload only its sanitized summary');
  add(errors,field(step(source,'Upload sanitized watchdog evidence'),'retention-days',10)===
    '          retention-days: 30',
    'watchdog evidence retention must remain 30 days');
  add(errors,field(step(source,'Upload sanitized watchdog evidence'),'if-no-files-found',10)===
    '          if-no-files-found: warn',
  'watchdog diagnostic upload must retain its explicit missing-file behavior');
  const alert=step(source,'Alert the accountable backup owner');
  add(errors,exactDirectKeys(step(source,'Upload sanitized watchdog evidence'),8,
    ['id','if','timeout-minutes','uses','with'])
    &&exactDirectKeys(alert,8,['if','shell','env','run'])
    &&field(alert,'if',8)===`        if: >-
          always() && (steps.discovery.outcome != 'success'
          || steps.upload.outcome != 'success'
          || steps.discovery.outputs.alert == 'true'
          || (steps.discovery.outputs.candidate == 'true'
          && (steps.download.outcome != 'success'
          || steps.verification.outcome != 'success'
          || steps.verification.outputs.alert != 'false')))`
    &&field(alert,'run',8)===WATCHDOG_ALERT_RUN,
  'watchdog failures and evidence-upload failures must end in an accountable terminal alert');
  return errors;
}

function validateCi(raw){
  const source=uncomment(raw);
  const errors=[];
  add(errors,exactWorkflowBytes(raw,WORKFLOW_DIGESTS.deployability),
    'backup-control CI workflow bytes must match the reviewed contract');
  add(errors,safeYamlSubset(source),
    'backup-control CI must use the reviewed unambiguous YAML subset');
  add(errors,exactDirectKeys(source,0,['name','on','permissions','concurrency','jobs']),
    'backup-control CI must contain only the reviewed top-level controls');
  add(errors,exactKeys(source,'on',0,['push','pull_request','workflow_dispatch'])
    &&/^  push:\n    branches: \[main\]$/m.test(block(source,'on',0))
    &&/^  pull_request:\n    branches: \[main, codex\/issue-87-repository-deployability\]$/m
    .test(block(source,'on',0)),
  'backup-control CI must run for pull requests into main and rolling');
  add(errors,exactKeys(source,'jobs',0,['deployability']),
    'backup-control CI must contain only the reviewed deployability job');
  add(errors,exactDirectKeys(block(source,'deployability',2),4,
    ['name','runs-on','timeout-minutes','steps']),
  'backup-control CI job fields must match the reviewed read-only contract');
  add(errors,JSON.stringify(stepHeaders(source))===JSON.stringify([
    'uses:actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses:actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'name:Validate repository release contract',
    'name:Validate secret-free backup controls',
    'name:Test release-contract failure modes',
  ]),'backup-control CI steps must match the reviewed secret-free sequence');
  add(errors,/^\s{8}run:\s*npm run check:backup-controls\s*$/m.test(source),
    'secret-free deployability CI must run the backup-control contract gate');
  add(errors,exactKeys(source,'permissions',0,['contents'])
    &&/^\s{2}contents:\s*read\s*$/m.test(block(source,'permissions',0))
    &&!/^\s{4,}permissions:/m.test(source)
    &&!hasSecretAccess(source)&&!/^\s{4}environment:/m.test(source),
  'backup-control CI must remain read-only and receive no environment or secrets');
  add(errors,unnamedCheckoutIsSafe(source),
    'backup-control CI checkout must be SHA-pinned and persist no credentials');
  add(errors,actionsAreExact(source,[
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  ]),'backup-control CI external actions must match the immutable reviewed allowlist');
  return errors;
}

export function validateBackupControlContract({rehearsal,watchdog,deployability}){
  return Object.freeze([
    ...validateRehearsal(rehearsal),
    ...validateWatchdog(watchdog),
    ...validateCi(deployability),
  ]);
}

function safeRead(root,path,errors){
  try{ return readFileSync(resolve(root,path),'utf8'); }
  catch{ errors.push(`required backup control file is unreadable: ${path}`); return ''; }
}

export function inspectBackupControlContract(rootDirectory=process.cwd()){
  const root=resolve(rootDirectory);
  const errors=[];
  const contract={
    rehearsal:safeRead(root,REHEARSAL_PATH,errors),
    watchdog:safeRead(root,WATCHDOG_PATH,errors),
    deployability:safeRead(root,DEPLOYABILITY_PATH,errors),
  };
  return Object.freeze([...errors,...validateBackupControlContract(contract)]);
}

function main(){
  const errors=inspectBackupControlContract();
  if(errors.length){
    process.stderr.write(`${JSON.stringify({ok:false,gate:'backup-control-contract',
      providerNetworkRequired:false,externalMutation:false,errors},null,2)}\n`);
    process.exitCode=1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ok:true,gate:'backup-control-contract',
    providerNetworkRequired:false,externalMutation:false})}\n`);
}

if(import.meta.url===pathToFileURL(resolve(process.argv[1]||'')).href) main();

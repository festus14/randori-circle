import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

import {
  inspectBackupControlContract,
  validateBackupControlContract,
} from '../../scripts/check-backup-controls.mjs';

function current(){
  return {
    rehearsal:readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8'),
    watchdog:readFileSync('.github/workflows/turso-backup-restore-watchdog.yml','utf8'),
    deployability:readFileSync('.github/workflows/deployability.yml','utf8'),
  };
}

function changed(key,from,to){
  const value=current();
  assert.match(value[key],typeof from==='string'?new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')):from);
  value[key]=value[key].replace(from,to);
  return validateBackupControlContract(value);
}

test('the repository satisfies the secret-free backup-control contract',()=>{
  assert.deepEqual(inspectBackupControlContract(),[]);
  assert.deepEqual(validateBackupControlContract(current()),[]);
});

test('any unreviewed workflow byte drift fails closed',()=>{
  assert.ok(changed('rehearsal','name: Turso backup restore rehearsal',
    'name: Turso backup restore rehearsal changed').includes(
    'rehearsal workflow bytes must match the reviewed contract'));
  assert.ok(changed('watchdog','name: Turso backup restore watchdog',
    'name: Turso backup restore watchdog changed').includes(
    'watchdog workflow bytes must match the reviewed contract'));
  assert.ok(changed('deployability','name: deployability',
    'name: deployability changed').includes(
    'backup-control CI workflow bytes must match the reviewed contract'));
});

test('rehearsal triggers, permissions, and immutable cadence fail closed',()=>{
  assert.ok(changed('rehearsal','  workflow_dispatch:',
    '  workflow_dispatch:\n  pull_request:').includes(
    'rehearsal triggers must be schedule and workflow_dispatch only'));
  assert.ok(changed('rehearsal','  workflow_dispatch:',
    "  workflow_dispatch:\n  'pull_request_target':").includes(
    'rehearsal workflow must use the reviewed unambiguous YAML subset'));
  assert.ok(changed('rehearsal',"    - cron: '17 3 * * 1'",
    "    - cron: '17 3 * * 1'\n    - cron: '18 3 * * 1'").includes(
    'rehearsal cadence must remain Monday 03:17 UTC'));
  assert.ok(changed('rehearsal','  contents: read','  contents: write').includes(
    'rehearsal permissions must be contents: read only'));
  assert.ok(changed('rehearsal','    environment: turso-migration-rehearsal',
    '    permissions: write-all\n    environment: turso-migration-rehearsal').includes(
    'rehearsal permissions must be contents: read only'));
  assert.ok(changed('rehearsal','    environment: turso-migration-rehearsal',
    "    'permissions': write-all\n    environment: turso-migration-rehearsal").includes(
    'rehearsal workflow must use the reviewed unambiguous YAML subset'));
  assert.ok(changed('rehearsal','  contents: read',"  contents: read\n  'id-token': write").includes(
    'rehearsal workflow must use the reviewed unambiguous YAML subset'));
  assert.ok(changed('rehearsal',"      github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    "      true || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)").includes(
    'rehearsal job must fail closed to default-branch schedule or exact manual confirmation'));
  assert.ok(changed('rehearsal',"cron: '17 3 * * 1'","cron: '17 4 * * 1'").includes(
    'rehearsal cadence must remain Monday 03:17 UTC'));
  assert.ok(changed('rehearsal',"REHEARSAL_RPO_TARGET_MS: '1800000'",
    "REHEARSAL_RPO_TARGET_MS: '3600000'").includes(
    'rehearsal and monitor must retain the fixed 30-minute RPO and 15-minute RTO'));
  assert.ok(changed('rehearsal','          MIGRATION_DIGEST_HMAC_KEY: ${{ secrets.MIGRATION_DIGEST_HMAC_KEY }}',
    "          MIGRATION_DIGEST_HMAC_KEY: ${{ secrets.MIGRATION_DIGEST_HMAC_KEY }}\n          EXTRA: ${{ secrets['EXTRA'] }}").includes(
    'rehearsal secret exposure must stay limited to the run, cleanup, and monitor contract'));
});

test('cleanup, healthy-evidence, artifact, and alert gates fail closed',()=>{
  assert.ok(changed('rehearsal','            --mode run \\',
    '            --mode cleanup \\').includes(
    'protected rehearsal command must match the reviewed bounded runner invocation'));
  assert.ok(changed('rehearsal','            --state-file "${RUNNER_TEMP}/private-recovery/state.json"',
    '            --state-file "${RUNNER_TEMP}/private-recovery/state.json"\n          curl https://example.invalid').includes(
    'protected rehearsal command must match the reviewed bounded runner invocation'));
  assert.ok(changed('rehearsal','            --mode cleanup \\',
    '            --mode cleanup \\\n          curl https://example.invalid \\').includes(
    'rehearsal must always run bounded source-state and disposable-restore cleanup'));
  assert.ok(changed('rehearsal',
    '          TURSO_PRODUCTION_DATABASE_NAME: ${{ vars.TURSO_PRODUCTION_DATABASE_NAME }}',
    '          TURSO_PRODUCTION_DATABASE_NAME: attacker-selected').includes(
    'rehearsal and monitor must retain the fixed 30-minute RPO and 15-minute RTO'));
  assert.ok(changed('rehearsal',
    '            --output "${RUNNER_TEMP}/public-artifacts/backup-monitor-summary.json"',
    '            --output "${RUNNER_TEMP}/public-artifacts/backup-monitor-summary.json"\n          curl https://example.invalid').includes(
    'rehearsal must always evaluate sanitized recovery evidence after installation'));
  assert.ok(changed('rehearsal','          exit 1',
    '          exit 0\n          exit 1').includes(
    'rehearsal monitor failures must end in an explicit terminal alert'));
  assert.ok(changed('rehearsal','if: always() && steps.source.outcome == \'success\'',
    'if: steps.source.outcome == \'success\'').includes(
    'rehearsal must always run bounded source-state and disposable-restore cleanup'));
  assert.ok(changed('rehearsal',"&& steps.cleanup_upload.outcome == 'success'",
    "&& steps.cleanup_upload.outcome != 'cancelled'").includes(
    'signed rehearsal evidence must require cleanup, upload, and healthy monitor success'));
  assert.ok(changed('rehearsal','${{ runner.temp }}/public-artifacts/cleanup-summary.json',
    '${{ runner.temp }}/private-recovery/state.json').includes(
    'rehearsal uploads must use only the three sanitized public artifacts'));
  assert.ok(changed('rehearsal',"steps.monitor.outcome != 'success'",
    "steps.monitor.outcome == 'failure'").includes(
    'rehearsal monitor failures must end in an explicit terminal alert'));
  assert.ok(changed('rehearsal',"always() && steps.source.outcome == 'success'",
    "always() && false && steps.source.outcome == 'success'").includes(
    'rehearsal must always run bounded source-state and disposable-restore cleanup'));
  assert.ok(changed('rehearsal',"always() && steps.rehearsal.outcome == 'success'",
    "always() || steps.rehearsal.outcome == 'success'").includes(
    'signed rehearsal evidence must require cleanup, upload, and healthy monitor success'));
});

test('watchdog permissions, isolation, schedule, and terminal alert fail closed',()=>{
  assert.ok(changed('watchdog','  actions: read','  actions: write').includes(
    'watchdog permissions must be actions: read and contents: read only'));
  assert.ok(changed('watchdog',"cron: '47 * * * *'","cron: '17 * * * *'").includes(
    'watchdog cadence must remain hourly at minute 47'));
  assert.ok(changed('watchdog','    runs-on: ubuntu-latest',
    '    environment: turso-migration-rehearsal\n    runs-on: ubuntu-latest').includes(
    'watchdog must not receive a protected environment or provider/application secrets'));
  assert.ok(changed('watchdog','    runs-on: ubuntu-latest',
    "    'environment': turso-migration-rehearsal\n    runs-on: ubuntu-latest").includes(
    'watchdog workflow must use the reviewed unambiguous YAML subset'));
  assert.ok(changed('watchdog','    runs-on: ubuntu-latest',
    '    ? permissions\n    : write-all\n    runs-on: ubuntu-latest').includes(
    'watchdog workflow must use the reviewed unambiguous YAML subset'));
  for(const decorated of ['&p permissions: write-all','!!str permissions: write-all']){
    assert.ok(changed('watchdog','    runs-on: ubuntu-latest',
      `    ${decorated}\n    runs-on: ubuntu-latest`).includes(
      'watchdog workflow must use the reviewed unambiguous YAML subset'));
  }
  assert.ok(changed('watchdog','    runs-on: ubuntu-latest',
    '    permissions: write-all\n    runs-on: ubuntu-latest').includes(
    'watchdog permissions must be actions: read and contents: read only'));
  assert.ok(changed('watchdog','          GITHUB_TOKEN: ${{ github.token }}',
    '          GITHUB_TOKEN: ${{ github.token }}\n          TOKEN: ${{ secrets.TURSO_TOKEN }}').includes(
    'watchdog must not receive a protected environment or provider/application secrets'));
  assert.ok(changed('watchdog','          GITHUB_TOKEN: ${{ github.token }}',
    "          GITHUB_TOKEN: ${{ github.token }}\n          TOKEN: ${{ secrets['TURSO_TOKEN'] }}").includes(
    'watchdog must not receive a protected environment or provider/application secrets'));
  assert.ok(changed('watchdog','          GITHUB_TOKEN: ${{ github.token }}',
    '          GITHUB_TOKEN: ${{ github.token }}\n          TOKEN: ${{ secrets.turso_token }}').includes(
    'watchdog must not receive a protected environment or provider/application secrets'));
  assert.ok(changed('watchdog','          GITHUB_TOKEN: ${{ github.token }}',
    '          GITHUB_TOKEN: ${{ github.token }}\n          DUMP: ${{ toJSON(secrets) }}').includes(
    'watchdog must not receive a protected environment or provider/application secrets'));
  assert.ok(changed('watchdog','    timeout-minutes: 20','    timeout-minutes: 200').includes(
    'watchdog job must retain its bounded timeout'));
  assert.ok(changed('watchdog','          node scripts/github-backup-restore-watchdog.mjs',
    '          gh workflow run turso-backup-restore-rehearsal.yml\n          node scripts/github-backup-restore-watchdog.mjs').includes(
    'watchdog must never dispatch or execute the protected provider rehearsal'));
  assert.ok(changed('watchdog',"|| steps.upload.outcome != 'success'",
    "|| steps.upload.outcome == 'failure'").includes(
    'watchdog failures and evidence-upload failures must end in an accountable terminal alert'));
  assert.ok(changed('watchdog',"always() && (steps.discovery.outcome != 'success'",
    "always() && false && (steps.discovery.outcome != 'success'").includes(
    'watchdog failures and evidence-upload failures must end in an accountable terminal alert'));
  assert.ok(changed('watchdog','          exit 1',
    '          exit 0\n          exit 1').includes(
    'watchdog failures and evidence-upload failures must end in an accountable terminal alert'));
  assert.ok(changed('watchdog','        shell: bash\n        env:',
    '        continue-on-error: True\n        shell: bash\n        env:').includes(
    'watchdog must not continue after a failed control step'));
});

test('external actions and checkout credentials must remain independently safe',()=>{
  assert.ok(changed('rehearsal','actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/setup-node@v4').includes(
    'rehearsal external actions must match the immutable reviewed allowlist'));
  assert.ok(changed('watchdog','actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    'actions/download-artifact@v4').includes(
    'watchdog external actions must match the immutable reviewed allowlist'));
  assert.ok(changed('rehearsal','          persist-credentials: false',
    '          # persist-credentials: false\n        env:\n          persist-credentials: false').includes(
    'rehearsal checkout must be SHA-pinned and persist no credentials'));
  assert.ok(changed('watchdog','          persist-credentials: false',
    '          persist-credentials: true').includes(
    'watchdog checkout must be SHA-pinned and persist no credentials'));
  assert.ok(changed('watchdog','      - name: Use the supported Node runtime',
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n\n      - name: Use the supported Node runtime').includes(
    'watchdog steps must match the reviewed read-only sequence'));
});

test('secret placement and upload allowlists cannot be satisfied by decoy steps',()=>{
  const moved=current();
  moved.rehearsal=moved.rehearsal.replace(
    '          TURSO_PRODUCTION_PLATFORM_TOKEN: ${{ secrets.TURSO_PRODUCTION_PLATFORM_TOKEN }}',
    '          TURSO_PRODUCTION_PLATFORM_TOKEN: moved-by-test',
  ).replace(
    '          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    '          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n          EXTRA: ${{ secrets.TURSO_PRODUCTION_PLATFORM_TOKEN }}',
  );
  assert.ok(validateBackupControlContract(moved).includes(
    'rehearsal secret exposure must stay limited to the run, cleanup, and monitor contract'));

  const movedRpo=current();
  movedRpo.rehearsal=movedRpo.rehearsal.replace("REHEARSAL_RPO_TARGET_MS: '1800000'",
    "REHEARSAL_RPO_TARGET_MS: '3600000'").replace(
    "          TURSO_PLATFORM_TIMEOUT_MS: '15000'\n          REHEARSAL_CLEANUP_POLL_ATTEMPTS:",
    "          TURSO_PLATFORM_TIMEOUT_MS: '15000'\n          REHEARSAL_RPO_TARGET_MS: '1800000'\n          REHEARSAL_CLEANUP_POLL_ATTEMPTS:",
  );
  assert.ok(validateBackupControlContract(movedRpo).includes(
    'rehearsal and monitor must retain the fixed 30-minute RPO and 15-minute RTO'));

  const movedFreshness=current();
  movedFreshness.watchdog=movedFreshness.watchdog.replace(
    "WATCHDOG_MAX_RUN_AGE_MS: '691200000'","WATCHDOG_MAX_RUN_AGE_MS: '1'",
  ).replace("          WATCHDOG_MAX_RUN_AGE_MS: '691200000'",
    "          WATCHDOG_MAX_RUN_AGE_MS: '691200000'\n          DECOY_MAX_RUN_AGE_MS: '691200000'");
  assert.ok(validateBackupControlContract(movedFreshness).includes(
    'watchdog freshness, stuck-run, grace, and absolute-deadline policy must remain fixed'));

  const movedRetention=current();
  movedRetention.watchdog=movedRetention.watchdog.replace('          retention-days: 30',
    '          retention-days: 1').replace("          WATCHDOG_STUCK_AFTER_MS: '5400000'",
    "          WATCHDOG_STUCK_AFTER_MS: '5400000'\n          retention-days: 30");
  assert.ok(validateBackupControlContract(movedRetention).includes(
    'watchdog evidence retention must remain 30 days'));

  assert.ok(changed('watchdog','      - name: Alert the accountable backup owner',
    `      - name: Upload unsafe extra evidence
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: unsafe-extra
          path: \${{ runner.temp }}/unsafe-extra.json
          retention-days: 30

      - name: Alert the accountable backup owner`).includes(
    'watchdog steps must match the reviewed read-only sequence'));
});

test('the deployability job is the read-only secret-free CI entry point',()=>{
  assert.ok(changed('deployability','  workflow_dispatch:',
    '  pull_request_target:\n  workflow_dispatch:').includes(
    'backup-control CI must run for pull requests into main and rolling'));
  assert.ok(changed('deployability','    branches: [main, codex/issue-87-repository-deployability]',
    '    branches: [main]').includes(
    'backup-control CI must run for pull requests into main and rolling'));
  assert.ok(changed('deployability','        run: npm run check:backup-controls',
    '        run: npm run check:deployability').includes(
    'secret-free deployability CI must run the backup-control contract gate'));
  assert.ok(changed('deployability','  contents: read','  contents: write').includes(
    'backup-control CI must remain read-only and receive no environment or secrets'));
  assert.ok(changed('deployability','    name: deployability',
    '    name: deployability\n    permissions: write-all').includes(
    'backup-control CI must remain read-only and receive no environment or secrets'));
  assert.ok(changed('deployability','    name: deployability',
    "    name: deployability\n    env:\n      TOKEN: ${{ secrets['TURSO_TOKEN'] }}").includes(
    'backup-control CI must remain read-only and receive no environment or secrets'));
  assert.ok(changed('deployability','    name: deployability',
    '    name: deployability\n    env:\n      DUMP: ${{ toJSON(secrets) }}').includes(
    'backup-control CI must remain read-only and receive no environment or secrets'));
  assert.ok(changed('deployability','          persist-credentials: false',
    '          persist-credentials: true').includes(
    'backup-control CI checkout must be SHA-pinned and persist no credentials'));
  assert.ok(changed('deployability','          persist-credentials: false',
    '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}').includes(
    'backup-control CI checkout must be SHA-pinned and persist no credentials'));
});

test('the CLI is offline, mutation-free, and never projects ambient secret values',()=>{
  const secret='backup-control-private-token@example.test';
  const result=spawnSync(process.execPath,['scripts/check-backup-controls.mjs'],{
    encoding:'utf8',
    env:{...process.env,TURSO_PRODUCTION_PLATFORM_TOKEN:secret,
      HTTPS_PROXY:'http://127.0.0.1:9'},
  });
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),{
    ok:true,gate:'backup-control-contract',providerNetworkRequired:false,externalMutation:false,
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`,new RegExp(secret.replace('.','\\.')));
});

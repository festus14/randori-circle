import {copyFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect,Page} from '@playwright/test';

export function stageRealRuntimeClient(repositoryRoot:string,rootDir:string){
  mkdirSync(join(rootDir,'assets'));
  copyFileSync(join(repositoryRoot,'index.html'),join(rootDir,'index.html'));
  copyFileSync(join(repositoryRoot,'assets','invite-gate.js'),join(rootDir,'assets','invite-gate.js'));
}

export async function expectInviteGateLoaded(page:Page){
  await expect.poll(()=>page.evaluate(() => typeof (window as typeof window & {
    _randori_invite_gate?:{create?:unknown};
  })._randori_invite_gate?.create)).toBe('function');
}

import {copyFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect,Page} from '@playwright/test';

export function stageRealRuntimeClient(repositoryRoot:string,rootDir:string){
  mkdirSync(join(rootDir,'assets'));
  copyFileSync(join(repositoryRoot,'index.html'),join(rootDir,'index.html'));
  // Stage every checked-in browser asset (invite gate, CRDT bundle, calendar
  // export, and anything a redesign adds) so the runtime serves the same
  // client the deployment does.
  for(const entry of readdirSync(join(repositoryRoot,'assets'),{withFileTypes:true})){
    if(entry.isFile()) copyFileSync(join(repositoryRoot,'assets',entry.name),join(rootDir,'assets',entry.name));
  }
}

export async function expectInviteGateLoaded(page:Page){
  await expect.poll(()=>page.evaluate(() => typeof (window as typeof window & {
    _randori_invite_gate?:{create?:unknown};
  })._randori_invite_gate?.create)).toBe('function');
}

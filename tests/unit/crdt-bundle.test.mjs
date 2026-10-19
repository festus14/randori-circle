import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCrdtBundle } from '../../scripts/check-crdt-bundle.mjs';

test('the checked-in CRDT browser bundle exactly matches its pinned local build',async()=>{
  assert.equal(await verifyCrdtBundle(),true);
});

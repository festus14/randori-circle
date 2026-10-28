// Issue #383: the durable deletion ledger lives in a SEPARATE database.
// This module is the ledger-DB client + statements for that database:
// no DDL, no app-DB migration, minimal entry shape only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  DELETION_LEDGER_DB_SCHEMA_VERSION,
  deletionLedgerDbConfig,
  deletionLedgerDbConfigured,
  destroyDeletionLedger,
  ledgerDbTimestamp,
  openDeletionLedgerDb,
  purgeDeletionLedgerEntries,
  readDeletionLedgerEntries,
  recordDeletionLedgerEntry,
  validateDeletionLedgerEntry,
} from '../../api/_deletion-ledger-db.js';
import { DELETION_LEDGER_DB_SCHEMA } from '../../scripts/deletion-ledger.mjs';

const CREATED='2026-01-01T00:00:00.000Z';
const DELETED='2026-10-26T10:00:00.000Z';
const LATER='2026-10-27T10:00:00.000Z';

async function ledgerDb(){
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-db-'));
  const path=join(directory,'ledger.db');
  const client=createClient({url:`file:${path}`});
  await client.execute({sql:DELETION_LEDGER_DB_SCHEMA,args:[]});
  return {client,directory,path,close:async()=>{ client.close(); rmSync(directory,{recursive:true,force:true}); }};
}

test('ledger DB config is null when unset, and a token without a URL fails loudly',()=>{
  assert.equal(deletionLedgerDbConfig({}),null);
  assert.equal(deletionLedgerDbConfigured({}),false);
  assert.throws(()=>deletionLedgerDbConfig({DELETION_LEDGER_AUTH_TOKEN:'x'}),
    /DELETION_LEDGER_DATABASE_URL is required/);
  assert.deepEqual(deletionLedgerDbConfig({DELETION_LEDGER_DATABASE_URL:'file:ledger.db'}),{
    url:'file:ledger.db',authToken:undefined,
  });
  assert.equal(deletionLedgerDbConfigured({DELETION_LEDGER_DATABASE_URL:'libsql://example'}),true);
  assert.deepEqual(
    deletionLedgerDbConfig({DELETION_LEDGER_DATABASE_URL:'libsql://example',DELETION_LEDGER_AUTH_TOKEN:'tok'}),
    {url:'libsql://example',authToken:'tok'},
  );
});

test('openDeletionLedgerDb returns null when unconfigured and a client when configured',async()=>{
  assert.equal(openDeletionLedgerDb({}),null);
  const {directory,path}=await (async()=>{
    const db=await ledgerDb();
    // Re-open through the env path against the same file, then close both.
    const opened=openDeletionLedgerDb({DELETION_LEDGER_DATABASE_URL:`file:${db.path}`});
    assert.equal(typeof opened.execute,'function');
    const rows=await opened.execute({sql:'SELECT COUNT(*) AS n FROM deletion_ledger',args:[]});
    assert.equal(Number(rows.rows[0].n),0);
    opened.close();
    await db.close();
    return db;
  })();
  assert.equal(typeof directory,'string');
  assert.equal(typeof path,'string');
});

test('validateDeletionLedgerEntry accepts the minimal shape and rejects anything else',()=>{
  assert.deepEqual(validateDeletionLedgerEntry({account_id:2,deleted_at:DELETED,created_at:CREATED}),{
    account_id:2,deleted_at:DELETED,created_at:CREATED,
  });
  assert.deepEqual(validateDeletionLedgerEntry({account_id:2,deleted_at:null,created_at:CREATED}).deleted_at,null);
  assert.throws(()=>validateDeletionLedgerEntry({account_id:2,deleted_at:DELETED,created_at:CREATED,email:'x@test'}),
    /exactly account_id, created_at and deleted_at/);
  assert.throws(()=>validateDeletionLedgerEntry({account_id:0,deleted_at:DELETED,created_at:CREATED}),
    /positive integer/);
  assert.throws(()=>validateDeletionLedgerEntry({account_id:2,deleted_at:DELETED,created_at:'2026-10-26 10:00:00'}),
    /valid created_at/);
  assert.throws(()=>validateDeletionLedgerEntry({account_id:2,deleted_at:'not-a-date',created_at:CREATED}),
    /valid deleted_at/);
  assert.throws(()=>ledgerDbTimestamp('2026-10-26T10:00:00Z','cutoff'),/valid cutoff/);
  assert.equal(DELETION_LEDGER_DB_SCHEMA_VERSION,1);
});

test('record + read round-trips entries, id-sorted, with no other columns',async()=>{
  const {client,close}=await ledgerDb();
  try{
    await recordDeletionLedgerEntry(client,{account_id:9,deleted_at:LATER,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:2,deleted_at:DELETED,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:5,deleted_at:null,created_at:CREATED});
    assert.deepEqual(await readDeletionLedgerEntries(client),[
      {account_id:2,deleted_at:DELETED,created_at:CREATED},
      {account_id:5,deleted_at:null,created_at:CREATED},
      {account_id:9,deleted_at:LATER,created_at:CREATED},
    ]);
    const columns=await client.execute({sql:'PRAGMA table_info(deletion_ledger)',args:[]});
    assert.deepEqual(columns.rows.map(row=>row.name),['account_id','deleted_at','created_at']);
  }finally{ await close(); }
});

test('record upsert: first known deletion time wins, null upgrades to a known time',async()=>{
  const {client,close}=await ledgerDb();
  try{
    await recordDeletionLedgerEntry(client,{account_id:2,deleted_at:DELETED,created_at:CREATED});
    // A retry must not replace the true deletion time with a later one.
    await recordDeletionLedgerEntry(client,{account_id:2,deleted_at:LATER,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:3,deleted_at:null,created_at:CREATED});
    // ...but a null entry upgrades when the true time becomes known.
    await recordDeletionLedgerEntry(client,{account_id:3,deleted_at:DELETED,created_at:CREATED});
    // ...and a null write never downgrades a known time.
    await recordDeletionLedgerEntry(client,{account_id:3,deleted_at:null,created_at:CREATED});
    assert.deepEqual(await readDeletionLedgerEntries(client),[
      {account_id:2,deleted_at:DELETED,created_at:CREATED},
      {account_id:3,deleted_at:DELETED,created_at:CREATED},
    ]);
  }finally{ await close(); }
});

test('purge destroys only entries deleted before the cutoff, never null entries',async()=>{
  const {client,close}=await ledgerDb();
  try{
    await recordDeletionLedgerEntry(client,{account_id:2,deleted_at:DELETED,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:3,deleted_at:LATER,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:4,deleted_at:null,created_at:CREATED});
    const purged=await purgeDeletionLedgerEntries(client,{before:LATER});
    assert.deepEqual(purged,{ok:true,purged:1});
    assert.deepEqual((await readDeletionLedgerEntries(client)).map(entry=>entry.account_id),[3,4]);
    // At the boundary: an entry deleted exactly at the cutoff stays.
    assert.deepEqual(await purgeDeletionLedgerEntries(client,{before:LATER}),{ok:true,purged:0});
    await assert.rejects(purgeDeletionLedgerEntries(client,{before:'not-a-date'}),/valid purge cutoff/);
  }finally{ await close(); }
});

test('destroy deletes every entry and returns the count',async()=>{
  const {client,close}=await ledgerDb();
  try{
    await recordDeletionLedgerEntry(client,{account_id:2,deleted_at:DELETED,created_at:CREATED});
    await recordDeletionLedgerEntry(client,{account_id:3,deleted_at:null,created_at:CREATED});
    assert.deepEqual(await destroyDeletionLedger(client),{ok:true,deleted:2});
    assert.deepEqual(await readDeletionLedgerEntries(client),[]);
    assert.deepEqual(await destroyDeletionLedger(client),{ok:true,deleted:0});
  }finally{ await close(); }
});

test('ledger functions require a client',async()=>{
  await assert.rejects(recordDeletionLedgerEntry(null,{account_id:2,deleted_at:DELETED,created_at:CREATED}),
    /database client is required/);
  await assert.rejects(readDeletionLedgerEntries(null),/database client is required/);
  await assert.rejects(purgeDeletionLedgerEntries(null,{before:DELETED}),/database client is required/);
  await assert.rejects(destroyDeletionLedger(null),/database client is required/);
});

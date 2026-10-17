// Source only; not run. Uses an isolated temporary database, never the application database.
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.mjs';

test('provider quota survives restart and is shared across all visitors',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mandateguard-model-budget-'));
  let store;
  try {
    store=new Store(directory);
    assert.equal(store.reserveModelCall(2),true);
    assert.equal(store.reserveModelCall(2),true);
    assert.equal(store.reserveModelCall(2),false);
    assert.equal(store.reserveModelCall(2),false);
    assert.throws(()=>store.reserveModelCall(0));
    assert.throws(()=>store.reserveModelCall(1001));
    assert.equal(store.reserveModelCall(3),true); // Explicit operator-configured increase, not a reset.
    assert.equal(store.reserveModelCall(3),false);
    store.close();store=null;store=new Store(directory);
    assert.equal(store.db.prepare("SELECT used FROM model_call_budget WHERE provider='openai'").get().used,3);
    assert.throws(()=>store.reserveModelCall(3),/duraklatıldı/); // Restart never resumes model work.
  } finally {store?.close();rmSync(directory,{recursive:true,force:true});}
});

test('extraction and proposal counters remain separate inside one durable three-call ceiling',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mg-workflow-budget-'));let store;
  try {
    store=new Store(directory);const workflowId=randomUUID();
    assert.equal(store.reserveModelCall(100,{workflowId,purpose:'extraction'}),true);
    assert.equal(store.reserveModelCall(100,{workflowId,purpose:'extraction'}),false);
    assert.equal(store.reserveModelCall(100,{workflowId,purpose:'proposal'}),true);
    assert.equal(store.reserveModelCall(100,{workflowId,purpose:'proposal'}),true);
    assert.equal(store.reserveModelCall(100,{workflowId,purpose:'proposal'}),false);
    assert.deepEqual({...store.modelWorkflowUsage(workflowId)},{total:3,extraction:1,proposal:2});
    assert.equal(store.db.prepare("SELECT used FROM model_call_budget WHERE provider='openai'").get().used,3);
    store.close();store=new Store(directory);
    assert.deepEqual({...store.modelWorkflowUsage(workflowId)},{total:3,extraction:1,proposal:2});
    assert.throws(()=>store.reserveModelCall(100,{workflowId,purpose:'proposal'}),/duraklatıldı/);
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});

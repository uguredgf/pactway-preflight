// Source only; not executed. All exchanges/planners are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {SafetyLane} from '../src/safety-lane.mjs';
import {decodeRecoverySnapshot} from '../src/persistence/recovery-format.mjs';
function setup() {
  const directory=mkdtempSync(join(tmpdir(),'pactway-recovery-')),store=new Store(directory),engine=new Engine(store,new FixturePlanner());
  const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
  const task=engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
  return {directory,store,engine,task};
}
test('cached identity survives a later database read failure without granting dispatch',async()=>{
  const env=setup();
  try {
    await env.engine.run(env.task.id);const lane=new SafetyLane(env.store);
    assert.equal(lane.sweep(Date.now()).ok,true);
    env.store.listRuntime=()=>{throw new Error('disk unavailable');};
    const failure=lane.sweep(Date.now());
    assert.equal(failure.ok,false);assert.equal(failure.work.length,1);
    assert.equal(failure.work[0].intentId,env.store.get(env.task.id).ledger.intents[0].id);
    assert.equal(failure.work[0].action,'QUERY');assert.equal(failure.work[0].dispatchAllowed,false);
    assert.equal(env.store.globalSafetyStatus().paused,true);
  } finally {env.store.close();rmSync(env.directory,{recursive:true,force:true});}
});
test('a fresh process without verified evidence cannot invent an emergency order identity',()=>{
  const env=setup();
  try {
    env.store.listRuntime=()=>{throw new Error('disk unavailable');};
    const failure=new SafetyLane(env.store).sweep(Date.now());assert.deepEqual(failure.work,[]);assert.equal(failure.ok,false);
  } finally {env.store.close();rmSync(env.directory,{recursive:true,force:true});}
});
test('backup restore preserves reserves, observations and quotas and revokes session reuse',async()=>{
  const env=setup(),target=mkdtempSync(join(tmpdir(),'pactway-restored-'));let restored;
  try {
    await env.engine.run(env.task.id);
    env.store.reserveModelCall(100);
    const before=env.engine.view(env.task.id).summary.reserved;
    env.store.pauseGlobal();const text=env.store.exportRecoverySnapshot(Date.now());
    assert.equal(Object.hasOwn(decodeRecoverySnapshot(text).tables,'visitor_sessions'),false);
    restored=new Store(target);const result=restored.restoreRecoverySnapshot(text);
    assert.equal(result.executionResumed,false);assert.equal(restored.globalSafetyStatus().reason,'RESTORE_RECONCILIATION_REQUIRED');
    const engine=new Engine(restored,new FixturePlanner());engine.recover();
    assert.equal(restored.get(env.task.id).ledger.intents[0].state,'UNKNOWN');assert.equal(engine.view(env.task.id).summary.reserved,before);
    assert.equal(restored.db.prepare("SELECT used FROM model_call_budget WHERE provider='openai'").get().used,1);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM visitor_sessions').get().n,0);
    assert.throws(()=>restored.restoreRecoverySnapshot(text),/new empty database/);
  } finally {restored?.close();env.store.close();rmSync(target,{recursive:true,force:true});rmSync(env.directory,{recursive:true,force:true});}
});
test('checksum mismatch and occupied targets do not overwrite existing tasks',()=>{
  const env=setup(),other=setup();
  try {
    env.store.pauseGlobal();const text=env.store.exportRecoverySnapshot(Date.now());
    const changed=JSON.parse(text);changed.createdAtMs++;
    assert.throws(()=>decodeRecoverySnapshot(JSON.stringify(changed)),/CHECKSUM/);
    const before=other.store.get(other.task.id);
    assert.throws(()=>other.store.restoreRecoverySnapshot(text),/not empty/);
    assert.deepEqual(other.store.get(other.task.id),before);assert.equal(other.store.globalSafetyStatus().paused,true);
    const path=join(env.directory,'recovery.json');env.store.writeRecoveryBackup(path,Date.now());
    assert.doesNotThrow(()=>decodeRecoverySnapshot(readFileSync(path,'utf8')));
    assert.throws(()=>env.store.writeRecoveryBackup(path,Date.now()));
  } finally {env.store.close();other.store.close();rmSync(env.directory,{recursive:true,force:true});rmSync(other.directory,{recursive:true,force:true});}
});
test('reopen pauses even a previously unpaused DB; missing DB with marker is not recreated',()=>{
  const env=setup();let reopened;
  try {
    env.store.close();reopened=new Store(env.directory);
    assert.equal(reopened.globalSafetyStatus().reason,'RESTART_RECONCILIATION_REQUIRED');
    reopened.close();reopened=null;
    unlinkSync(join(env.directory,'mandateguard.db'));
    assert.throws(()=>new Store(env.directory),/database missing/);
  } finally {reopened?.close();rmSync(env.directory,{recursive:true,force:true});}
});

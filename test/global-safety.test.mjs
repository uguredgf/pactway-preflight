// Acceptance source only. Not executed; no live transport/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {SafetyLane} from '../src/safety-lane.mjs';
import {ExecutionQueue} from '../src/execution-queue.mjs';
function setup(planner=new FixturePlanner()) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-safety-')),store=new Store(directory),engine=new Engine(store,planner);
  const create=()=>{const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
    return engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});};
  return {directory,store,engine,create,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('pause is durable across reopen and blocks new work without blocking reads',()=>{
  const env=setup();let reopened;
  try {
    const task=env.create();assert.equal(env.store.pauseGlobal().durablePaused,true);
    assert.throws(()=>env.create(),/duraklatıldı/);assert.equal(env.store.get(task.id).id,task.id);
    assert.throws(()=>env.store.reserveModelCall(100),/duraklatıldı/);
    env.store.close();reopened=new Store(env.directory);
    assert.equal(reopened.globalSafetyStatus().paused,true);assert.throws(()=>reopened.assertNewWorkAllowed(),/duraklatıldı/);
  } finally {if(reopened)reopened.close();rmSync(env.directory,{recursive:true,force:true});}
});
test('failed durable pause holds the process latch and reports uncertainty',()=>{
  const env=setup();
  try {
    env.store.db.exec("CREATE TRIGGER refuse_pause BEFORE UPDATE ON global_safety BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    const result=env.store.pauseGlobal();
    assert.equal(result.paused,true);assert.equal(result.durablePaused,false);assert.equal(result.reason,'STORAGE_UNCERTAIN');
    assert.throws(()=>env.store.assertNewWorkAllowed(),/duraklatıldı/);
  } finally {env.close();}
});
test('safety sweep does not await model completion and discards late proposal',async()=>{
  let resolve;
  const env=setup({kind:'test',propose:()=>new Promise(done=>{resolve=done;})});
  try {
    const task=env.create(),pending=env.engine.advance(task.id);env.store.pauseGlobal();
    const result=new SafetyLane(env.store).sweep(Date.now());assert.equal(result.ok,true);
    assert.equal(env.store.get(task.id).ledger.stopRequested,true);assert.equal(env.store.get(task.id).busy,true);
    resolve({action:'propose',price:'24.80',size:'0.1',reason:'late'});await pending;
    assert.equal(env.store.get(task.id).ledger.intents.length,0);assert.equal(env.store.get(task.id).busy,false);
  } finally {env.close();}
});
test('UNKNOWN retains its reserve and requires query; pause never fabricates cancellation',async()=>{
  const env=setup();
  try {
    const task=env.create();await env.engine.run(task.id);env.engine.scenario(task.id,'unknown');
    const before=env.engine.view(task.id).summary.reserved;env.store.pauseGlobal();
    const result=new SafetyLane(env.store).sweep(Date.now());
    assert.equal(result.work[0].action,'QUERY');assert.equal(result.work[0].dispatchAllowed,false);
    assert.equal(env.store.get(task.id).ledger.intents[0].state,'UNKNOWN');
    assert.equal(env.engine.view(task.id).summary.reserved,before);
    assert.equal(result.transportConnected,false);
  } finally {env.close();}
});
test('queued work is cancelled locally, while observation and stop paths remain usable',()=>{
  const env=setup();
  try {
    const task=env.create(),queue=new ExecutionQueue(env.store,env.engine);queue.enqueue(task.id);
    env.store.pauseGlobal();new SafetyLane(env.store).sweep(Date.now());
    assert.equal(env.store.get(task.id).queue.state,'CANCELLED');
    assert.throws(()=>queue.enqueue(task.id),/duraklatıldı/);
    assert.doesNotThrow(()=>env.engine.stop(task.id));
  } finally {env.close();}
});
test('one broken task cannot prevent safety attempts for other tasks',()=>{
  const env=setup();
  try {
    const first=env.create(),draft=env.engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'},'other');
    const second=env.engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true},'other');
    const attempted=[],update=env.store.update.bind(env.store);
    env.store.update=(id,...args)=>{attempted.push(id);if(id===first.id)throw new Error('audit unavailable');return update(id,...args);};
    env.store.pauseGlobal();const result=new SafetyLane(env.store).sweep(Date.now());
    assert.equal(attempted.includes(first.id),true);assert.equal(attempted.includes(second.id),true);
    assert.deepEqual(result.failures,[first.id]);assert.equal(env.store.get(second.id).ledger.stopRequested,true);
  } finally {env.close();}
});

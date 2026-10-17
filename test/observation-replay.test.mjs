// Source acceptance cases only. Not executed; fixture sources, no exchange/model API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
async function setup() {
  const directory=mkdtempSync(join(tmpdir(),'pactway-replay-')),store=new Store(directory),engine=new Engine(store,new FixturePlanner());
  const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
  const task=engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
  await engine.run(task.id);const intent=store.get(task.id).ledger.intents[0];
  const capture=(patch={})=>store.captureObservation({taskId:task.id,intentId:intent.id,source:'fixture-fill',
    payload:{tradeId:'replay-trade',baseQty:'0.01',quoteNotional:'0.248',feeQuote:'0.001',feeBase:'0',feesComplete:true,...patch}});
  return {store,engine,task,intent,capture,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('same reviewed observation applies once; pause and reserve are not reset',async()=>{
  const env=await setup();
  try {
    const id=env.capture();env.store.quarantineObservation(id);
    const review=env.store.reviewObservation({kind:'fixture',id});
    assert.throws(()=>env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash}),/REQUIRES_PAUSE/);
    env.store.pauseGlobal();const result=env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash});
    assert.equal(result.status,'APPLIED');assert.equal(result.executionResumed,false);
    const after=env.store.get(env.task.id),count=env.store.receipts(env.task.id).length;
    const again=env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash});
    assert.equal(again.duplicate,true);assert.equal(env.store.get(env.task.id).revision,after.revision);
    assert.equal(env.store.receipts(env.task.id).length,count);assert.equal(after.ledger.intents[0].fills.length,1);
    assert.equal(env.store.globalSafetyStatus().paused,true);assert.equal(after.ledger.intents[0].settled,false);
  } finally {env.close();}
});
test('task revision or stored payload changes invalidate the reviewed token',async()=>{
  const env=await setup();
  try {
    const id=env.capture();env.store.pauseGlobal();const review=env.store.reviewObservation({kind:'fixture',id});
    env.engine.stop(env.task.id);
    assert.throws(()=>env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash}),/REVIEW_STALE/);
    const fresh=env.store.reviewObservation({kind:'fixture',id});
    env.store.db.prepare('UPDATE observations SET payload=? WHERE id=?').run(JSON.stringify({tradeId:'changed'}),id);
    assert.throws(()=>env.store.replayFixtureObservation({id,expectedReviewHash:fresh.reviewHash}),/REVIEW_STALE/);
    assert.equal(env.store.get(env.task.id).ledger.intents[0].fills.length,0);
  } finally {env.close();}
});
test('failure writing replay receipt rolls back ledger, audit and observation status together',async()=>{
  const env=await setup();
  try {
    const id=env.capture();env.store.quarantineObservation(id);env.store.pauseGlobal();
    const review=env.store.reviewObservation({kind:'fixture',id}),before=env.store.get(env.task.id),count=env.store.receipts(env.task.id).length;
    env.store.db.exec("CREATE TRIGGER reject_replay BEFORE INSERT ON observation_replays BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    assert.throws(()=>env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash}));
    assert.deepEqual(env.store.get(env.task.id),before);assert.equal(env.store.receipts(env.task.id).length,count);
    assert.equal(env.store.reviewObservation({kind:'fixture',id}).status,'QUARANTINED');
  } finally {env.close();}
});
test('actual over-cost is retained and quarantine is never cleared by replay',async()=>{
  const env=await setup();
  try {
    const id=env.capture({quoteNotional:'120'});env.store.pauseGlobal();
    const review=env.store.reviewObservation({kind:'fixture',id});
    const result=env.store.replayFixtureObservation({id,expectedReviewHash:review.reviewHash});
    assert.equal(result.status,'QUARANTINED');assert.equal(env.engine.view(env.task.id).summary.spent,'120.001');
    assert.equal(env.store.hasUnappliedObservations(),true);assert.equal(env.store.globalSafetyStatus().paused,true);
  } finally {env.close();}
});
test('a conflicting duplicate fee cannot replace previously applied economics',async()=>{
  const env=await setup();
  try {
    const first=env.capture();env.store.pauseGlobal();
    env.store.replayFixtureObservation({id:first,expectedReviewHash:env.store.reviewObservation({kind:'fixture',id:first}).reviewHash});
    const second=env.capture({feeQuote:'0.002'}),before=env.store.get(env.task.id);
    const review=env.store.reviewObservation({kind:'fixture',id:second});
    assert.throws(()=>env.store.replayFixtureObservation({id:second,expectedReviewHash:review.reviewHash}),/Conflicting duplicate fee/);
    assert.deepEqual(env.store.get(env.task.id),before);assert.equal(env.store.reviewObservation({kind:'fixture',id:second}).status,'PENDING');
  } finally {env.close();}
});
test('ATK observations support review/quarantine only, without an APPLIED shortcut',async()=>{
  const env=await setup();
  try {
    const prepared=prepareATKObservation({schemaVersion:1,observationId:'atk-1',callId:'call-1',connectionHash:'a'.repeat(64),
      catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),sessionId:'session',accountId:'account',taskId:null,intentId:null,
      tool:'account_get_balance',args:{},requestedAtMs:100,receivedAtMs:101},{structuredContent:{value:'1'}});
    assert.equal(prepared.ok,true);env.store.captureATKToolObservation(prepared.record);
    const review=env.store.reviewObservation({kind:'atk',id:'atk-1'});assert.equal(review.replaySupported,false);
    const next=env.store.quarantineATKObservation({id:'atk-1',expectedReviewHash:review.reviewHash});
    assert.equal(next.status,'QUARANTINED');assert.equal(env.store.hasUnappliedObservations(),true);
    assert.throws(()=>env.store.replayFixtureObservation({id:'atk-1',expectedReviewHash:next.reviewHash}),/REPLAY_INPUT/);
  } finally {env.close();}
});

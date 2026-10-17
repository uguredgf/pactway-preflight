// Local component integration: the server's safety-sweep -> queue-pump order.
// No server, provider, exchange, model or blockchain transport is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {ExecutionQueue} from '../src/execution-queue.mjs';
import {SafetyLane} from '../src/safety-lane.mjs';

const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
function setup() {
  const root=realpathSync(tmpdir()),directory=mkdtempSync(join(root,'pactway-queue-expiry-'));
  const store=new Store(directory),engine=new Engine(store,new FixturePlanner());
  const queue=new ExecutionQueue(store,engine),safety=new SafetyLane(store,{
    isOwnerActive:(state,now)=>Boolean(state.ownerId) && store.ownerSessionActive(state.ownerId,now)
  });
  return {store,engine,queue,safety,
    approve(ownerId) {
      store.saveSession({tokenHash:'token-'+ownerId,ownerId,csrf:'local-test-csrf',expiresAtMs:Date.now()+3600000});
      const draft=engine.draft(fields,ownerId);
      return engine.approveAndEnqueue({draftId:draft.id,expectedRevision:draft.revision,
        policyHash:draft.policyHash,acknowledgement:true},ownerId).task;
    },
    async tick(now) {
      // Match src/server.mjs tick. Awaiting pump only makes assertions deterministic.
      const result=safety.sweep(now);
      if(result.ok)await queue.pump();
      return result;
    },
    close() {
      store.close();const target=realpathSync(directory);
      assert.equal(dirname(target),root);assert.ok(basename(target).startsWith('pactway-queue-expiry-'));
      rmSync(target,{recursive:true,force:true});
    }
  };
}

for(const heldState of ['OPEN','UNKNOWN'])test(`server tick expires all waiting work behind ${heldState} without releasing held reserve`,async t=>{
  const f=setup();let now=Date.now();t.mock.method(Date,'now',()=>now);
  try {
    const held=f.approve('held-owner');await f.queue.pump();
    assert.equal(f.store.get(held.id).ledger.intents[0].state,'OPEN');
    const waiting=['waiting-a','waiting-b','waiting-c'].map(owner=>f.approve(owner));
    if(heldState==='UNKNOWN')f.engine.scenario(held.id,'unknown');
    const before=f.store.get(held.id),summary=f.engine.view(held.id).summary;
    assert.notEqual(summary.reserved,'0');
    const run=t.mock.method(f.engine,'run',async()=>{assert.fail('Expiry must not start queued work');});

    now=waiting[0].queue.expiresAtMs-1;
    assert.equal((await f.tick(now)).ok,true);
    assert.equal(f.store.listQueued().length,3);
    now++;
    const result=await f.tick(now);
    assert.equal(result.ok,true);assert.equal(f.store.listQueued().length,0);
    for(const original of waiting) {
      const saved=f.store.get(original.id);
      assert.equal(saved.queue.state,'CANCELLED');assert.equal(saved.ledger.stopRequested,true);
      assert.equal(saved.ledger.phase,'STOPPED');assert.equal(saved.ledger.intents.length,0);
      assert.equal(saved.queue.expiresAtMs,original.queue.expiresAtMs);
      assert.deepEqual(saved.policy,original.policy);assert.deepEqual(saved.approvalRequest,original.approvalRequest);
      assert.equal(f.store.verifySafetyTask(saved),true);
    }
    const after=f.store.get(held.id),afterSummary=f.engine.view(held.id).summary;
    assert.deepEqual(after.ledger.intents,before.ledger.intents);
    assert.equal(afterSummary.reserved,summary.reserved);assert.equal(afterSummary.spent,summary.spent);
    assert.equal(afterSummary.remaining,summary.remaining);assert.equal(after.queue.state,'BLOCKED');
    assert.equal(result.work.length,1);assert.equal(result.work[0].dispatchAllowed,false);
    assert.equal(result.work[0].action,heldState==='UNKNOWN'?'QUERY':'CANCEL_THEN_QUERY');
    const receipts=waiting.map(task=>f.store.receipts(task.id).length);
    await f.tick(now+1);
    assert.deepEqual(waiting.map(task=>f.store.receipts(task.id).length),receipts);
    assert.equal(run.mock.callCount(),0);
  } finally {t.mock.restoreAll();f.close();}
});

test('server tick cancels waiting tasks on global pause before their deadlines',async t=>{
  const f=setup();
  try {
    const waiting=['pause-a','pause-b','pause-c'].map(owner=>f.approve(owner));
    const run=t.mock.method(f.engine,'run',async()=>{assert.fail('Paused work must not run');});
    f.store.pauseGlobal();const result=await f.tick(Date.now());
    assert.equal(result.ok,true);assert.equal(f.store.listQueued().length,0);
    for(const original of waiting) {
      const saved=f.store.get(original.id);
      assert.equal(saved.queue.state,'CANCELLED');assert.equal(saved.ledger.stopRequested,true);
      assert.equal(saved.queue.expiresAtMs,original.queue.expiresAtMs);
      assert.deepEqual(saved.policy,original.policy);assert.equal(saved.ledger.intents.length,0);
    }
    assert.equal(run.mock.callCount(),0);
  } finally {t.mock.restoreAll();f.close();}
});

test('failed safety verification suppresses pump but still expires other verified waiting tasks',async t=>{
  const f=setup();let now=Date.now();t.mock.method(Date,'now',()=>now);
  try {
    const broken=f.approve('broken-owner'),healthy=f.approve('healthy-owner');
    const verify=f.store.verifySafetyTask.bind(f.store);
    t.mock.method(f.store,'verifySafetyTask',state=>state.id===broken.id?false:verify(state));
    const pump=t.mock.method(f.queue,'pump',async()=>{assert.fail('Failed safety sweep must not pump');});
    now=healthy.queue.expiresAtMs;
    const result=await f.tick(now);
    assert.equal(result.ok,false);assert.deepEqual(result.failures,[broken.id]);
    assert.equal(f.store.globalSafetyStatus().paused,true);
    assert.equal(f.store.get(healthy.id).queue.state,'CANCELLED');
    assert.equal(f.store.get(healthy.id).ledger.intents.length,0);
    assert.equal(f.store.get(broken.id).queue.state,'QUEUED');
    assert.equal(pump.mock.callCount(),0);
  } finally {t.mock.restoreAll();f.close();}
});

// Acceptance SOURCES only: temporary SQLite + controlled planner, no server/SDK/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {ExecutionQueue} from '../src/execution-queue.mjs';

const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
const wait={action:'wait',price:null,size:null,reason:'Controlled acceptance wait'};
const proposal={action:'propose',price:'24.80',size:'0.1',reason:'Controlled fixture proposal'};
const request=draft=>({draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true});

function setup() {
  const directory=mkdtempSync(join(tmpdir(),'pactway-acceptance-')),store=new Store(directory);
  let complete=null,calls=0;
  // Reserve exactly where a provider would start IO, but never construct a provider.
  const planner={kind:'fixture',propose(input){
    assert.equal(store.reserveOwnedModelCall(100,{workflowId:input.policy.workflowId,
      ownerId:input.ownerId,taskId:input.policy.taskId,purpose:'proposal'}),true);
    calls++;
    return new Promise(resolve=>{complete=resolve;});
  }};
  const engine=new Engine(store,planner,{isExecutionAuthorized:state=>store.ownerSessionActive(state.ownerId,Date.now())});
  const queue=new ExecutionQueue(store,engine);
  function draft(owner) {
    store.saveSession({tokenHash:'acceptance-'+owner,ownerId:owner,csrf:'test-only-csrf',expiresAtMs:Date.now()+3600000});
    return engine.draft(fields,owner);
  }
  function approve(owner) {
    const reviewed=draft(owner),input=request(reviewed);
    return {id:reviewed.id,owner,input,result:engine.approveAndEnqueue(input,owner)};
  }
  function resolve(value=wait){const done=complete;complete=null;if(done)done(value);}
  return {store,engine,queue,draft,approve,resolve,get calls(){return calls;},async close(){
    resolve();await queue.close();store.close();rmSync(directory,{recursive:true,force:true});
  }};
}

test('A08: concurrent pumps preserve one active workflow plus three waiting approvals',async()=>{
  const f=setup();
  try {
    const first=f.approve('owner-a'),running=f.queue.pump();
    assert.equal(f.calls,1);assert.equal(f.store.get(first.id).queue.state,'RUNNING');
    const waiting=['owner-b','owner-c','owner-d'].map(owner=>f.approve(owner));
    const overflow=f.draft('owner-e');
    assert.throws(()=>f.engine.approveAndEnqueue(request(overflow),'owner-e'),{code:'QUEUE_CAPACITY_EXCEEDED'});
    assert.equal(f.store.policyWorkflow(overflow.id,'owner-e').taskId,null);
    await Promise.all([f.queue.pump(),f.queue.pump(),f.queue.pump()]);
    assert.equal(f.calls,1);assert.equal(f.store.listQueued().length,3);
    for(const task of waiting)assert.equal(f.store.get(task.id).ledger.intents.length,0);
    const before=f.store.get(first.id),receipts=f.store.receipts(first.id);
    assert.equal(f.engine.approveAndEnqueue(first.input,first.owner).replayed,true);
    assert.deepEqual(f.store.get(first.id),before);assert.deepEqual(f.store.receipts(first.id),receipts);
    assert.equal(f.store.modelWorkflowUsage(first.id).total,1);
    f.resolve();await running;
    assert.equal(f.store.get(first.id).queue.state,'RELEASED');
    assert.equal(f.store.listQueued().length,3);
    // A released approval cannot jump back into the waiting lane.
    assert.equal(f.queue.enqueue(first.id).queue.state,'RELEASED');
    const next=f.queue.waiting()[0],nextRun=f.queue.pump();
    assert.equal(f.calls,2);assert.equal(f.store.get(next.id).queue.state,'RUNNING');
    f.resolve();await nextRun;
  } finally {await f.close();}
});

for(const [gate,decision] of [
  ['stop','LATE_PROPOSAL_DISCARDED'],
  ['pause','GLOBAL_PAUSE_PROPOSAL_DISCARDED'],
  ['owner','OWNER_SESSION_ENDED'],
  ['deadline','QUEUE_DEADLINE_PROPOSAL_DISCARDED']
])test(`A09: ${gate} during the atomic workflow's model wait prevents reservation and submission`,async t=>{
  const f=setup();
  try {
    const task=f.approve('owner-a'),running=f.queue.pump(),before=f.store.get(task.id);
    assert.equal(f.calls,1);assert.equal(before.busy,true);
    if(gate==='stop')f.engine.stop(task.id);
    if(gate==='pause')f.store.pauseGlobal();
    if(gate==='owner')f.store.revokeSession('acceptance-'+task.owner);
    if(gate==='deadline')t.mock.method(Date,'now',()=>before.queue.expiresAtMs);
    f.resolve(proposal);await running;
    const saved=f.engine.view(task.id);
    assert.equal(saved.busy,false);assert.equal(saved.ledger.intents.length,0);
    assert.equal(saved.summary.spent,'0');assert.equal(saved.summary.reserved,'0');
    assert.equal(saved.submission,undefined);assert.equal(saved.queue.state,'RELEASED');
    assert.equal(saved.queue.expiresAtMs,before.queue.expiresAtMs);
    assert.equal(saved.policy.expiresAtMs,before.policy.expiresAtMs);
    assert.ok(saved.receipts.some(receipt=>receipt.source.decision.kind===decision));
    assert.equal(f.store.modelWorkflowUsage(task.id).total,1);
    await f.queue.pump();assert.equal(f.calls,1);
    if(gate==='owner')assert.throws(()=>f.engine.approveAndEnqueue(task.input,task.owner),error=>error.status===401);
    else assert.equal(f.engine.approveAndEnqueue(task.input,task.owner).replayed,true);
    assert.equal(f.store.list().length,1);
  } finally {t.mock.restoreAll();await f.close();}
});

test('A10: partial fill, UNKNOWN and cancellation retain the lane and spend until fixture reconciliation',async()=>{
  const f=setup();
  try {
    const first=f.approve('owner-a'),run=f.queue.pump(),second=f.approve('owner-b');
    f.resolve(proposal);await run;
    assert.equal(f.store.get(first.id).ledger.intents.length,1);
    const partial=f.engine.scenario(first.id,'partial');
    assert.notEqual(partial.summary.spent,'0');assert.notEqual(partial.summary.reserved,'0');
    f.engine.scenario(first.id,'unknown');
    const held=f.engine.view(first.id);
    await f.queue.pump();await f.queue.pump();
    assert.equal(f.calls,1);assert.equal(f.store.get(second.id).queue.state,'QUEUED');
    assert.equal(f.engine.approveAndEnqueue(first.input,first.owner).replayed,true);
    assert.equal(f.engine.view(first.id).summary.reserved,held.summary.reserved);
    f.engine.stop(first.id);await f.queue.pump();
    assert.equal(f.calls,1);assert.equal(f.engine.view(first.id).summary.reserved,held.summary.reserved);
    const settled=f.engine.scenario(first.id,'confirm-cancel');
    assert.equal(settled.summary.spent,partial.summary.spent);assert.equal(settled.summary.reserved,'0');
    const next=f.queue.pump();assert.equal(f.calls,2);
    f.resolve();await next;
    assert.equal(f.store.get(first.id).ledger.intents.length,1);
    assert.equal(f.store.get(second.id).ledger.intents.length,0);
    assert.equal(f.store.modelWorkflowUsage(first.id).total,1);
  } finally {await f.close();}
});

// Acceptance sources only. Not executed; no SDK, server or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {ExecutionQueue} from '../src/execution-queue.mjs';
import {DemoExecutor} from '../src/demo-executor.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {demoPolicyConfiguration} from '../src/demo-policy.mjs';
import {hashCanonical} from '../src/domain/governor.mjs';

const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
const request=draft=>({draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true});
function session(store,owner) {
  store.saveSession({tokenHash:'token-'+owner,ownerId:owner,csrf:'test-only-csrf',expiresAtMs:Date.now()+3600000});
}
function setup({demo=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-approval-')),store=new Store(directory);
  const owner=demo?'demo-owner':'local-operator';
  let configuration=null;
  if(demo) {
    session(store,owner);
    const campaign=store.createCampaign({id:'shared-campaign',version:1,accountId:'demo-account',connectionVersion:'connection-v1',
      environment:'demo',instrument:'AVAX-USDT',budget:'1000',maxShare:'0.2'});
    configuration={campaignId:campaign.config.id,campaignHash:campaign.configHash,quoteFeeRateMax:'0.002',quoteFeeFixedMax:'0.01',
      baseFeeRateMax:'0.002',orderLifetimeMs:30000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:2000};
  }
  const planner=demo?{kind:'openai',async propose(){throw new Error('TEST_MUST_NOT_CALL_MODEL');}}:new FixturePlanner();
  const engine=new Engine(store,planner,{executionMode:demo?'demo-prepared':'fixture',demoPolicy:configuration});
  return {directory,store,engine,owner,configuration,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('lost approval response returns one task, queue entry and audit receipt without resetting quota',()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),input=request(draft);
    const first=f.engine.approveAndEnqueue(input),before=f.store.get(draft.id);
    assert.equal(first.replayed,false);assert.equal(before.queue.state,'QUEUED');
    assert.equal(f.store.policyWorkflow(draft.id,f.owner).taskId,draft.id);
    f.store.reserveOwnedModelCall(100,{workflowId:draft.id,ownerId:f.owner,taskId:draft.id,purpose:'proposal'});
    const retry=f.engine.approveAndEnqueue(input);
    assert.equal(retry.replayed,true);assert.deepEqual(retry.task,before);
    assert.equal(f.store.list().length,1);assert.equal(f.store.listQueued().length,1);
    assert.equal(f.store.receipts(draft.id).length,1);assert.equal(f.store.modelWorkflowUsage(draft.id).total,1);
    assert.equal(f.store.receipts(draft.id)[0].source.decision.kind,'POLICY_APPROVED_AND_QUEUED');
    assert.equal(f.store.verifySafetyTask(retry.task),true);
  } finally {f.close();}
});

test('same workflow with different hash/revision or owner is rejected; stale approval consumes nothing',()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),old=request(draft);
    const edited=f.engine.drafts.edit(f.owner,draft.id,{expectedRevision:draft.revision,fields:{maxPrice:'24'}});
    assert.throws(()=>f.engine.approveAndEnqueue(old),/APPROVAL_DRAFT_CHANGED/);
    assert.equal(f.store.get(draft.id),null);assert.equal(f.store.policyWorkflow(draft.id,f.owner).taskId,null);
    f.engine.approveAndEnqueue(request(edited));
    assert.throws(()=>f.engine.approveAndEnqueue(old),/APPROVAL_CONFLICT/);
    assert.throws(()=>f.engine.approveAndEnqueue(request(edited),'another-owner'),{code:'DRAFT_NOT_FOUND'});
    assert.throws(()=>f.engine.approveAndEnqueue({...request(edited),candidate:{size:'100'}}),{code:'APPROVAL_INPUT'});
    assert.throws(()=>f.engine.approveAndEnqueue({...request(edited),acknowledgement:false}),{code:'APPROVAL_INPUT'});
  } finally {f.close();}
});

test('failure after draft binding rolls back task, queue, audit and draft consumption together',()=>{
  const f=setup({demo:true});
  try {
    const draft=f.engine.draft(fields,f.owner),campaign=f.store.campaign(f.configuration.campaignId);
    f.store.db.exec("CREATE TEMP TRIGGER reject_approval_outbox BEFORE INSERT ON receipt_outbox BEGIN SELECT RAISE(ABORT,'TEST_COMMIT_FAILURE'); END;");
    assert.throws(()=>f.engine.approveAndEnqueue(request(draft),f.owner),/TEST_COMMIT_FAILURE/);
    assert.equal(f.store.get(draft.id),null);assert.equal(f.store.receipts(draft.id).length,0);
    assert.equal(f.store.listQueued().length,0);assert.equal(f.store.policyWorkflow(draft.id,f.owner).taskId,null);
    assert.deepEqual(f.store.campaign(f.configuration.campaignId),campaign);
    f.store.db.exec('DROP TRIGGER reject_approval_outbox');
    assert.equal(f.engine.approveAndEnqueue(request(draft),f.owner).replayed,false);
  } finally {f.close();}
});

test('capacity and per-owner active task gates do not consume rejected drafts',()=>{
  const f=setup();
  try {
    for(const owner of ['owner-a','owner-b','owner-c']) {
      session(f.store,owner);const draft=f.engine.draft(fields,owner);
      f.engine.approveAndEnqueue(request(draft),owner);
    }
    session(f.store,'owner-d');const waiting=f.engine.draft(fields,'owner-d');
    assert.throws(()=>f.engine.approveAndEnqueue(request(waiting),'owner-d'),/capacity/);
    assert.equal(f.store.policyWorkflow(waiting.id,'owner-d').taskId,null);
    const occupied=f.engine.draft(fields,'owner-a');
    assert.throws(()=>f.engine.approveAndEnqueue(request(occupied),'owner-a'));
    assert.equal(f.store.policyWorkflow(occupied.id,'owner-a').taskId,null);
  } finally {f.close();}
});

test('completion, pause and expiry do not change duplicate result or authorize requeue',t=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),input=request(draft);f.engine.approveAndEnqueue(input);
    f.engine.stop(draft.id);const queue=new ExecutionQueue(f.store,f.engine);queue.cancelWaiting(draft.id);
    f.store.pauseGlobal();const before=f.store.get(draft.id),now=Date.now();
    t.mock.method(Date,'now',()=>now+700000);
    assert.deepEqual(f.engine.approveAndEnqueue(input).task,before);
    assert.equal(queue.enqueue(draft.id).queue.state,'CANCELLED');
    assert.deepEqual(f.store.get(draft.id),before);
  } finally {t.mock.restoreAll();f.close();}
});

test('restart and recovery carry idempotency but never resume the queue',()=>{
  const f=setup(),target=setup();let restarted=null;
  try {
    const draft=f.engine.draft(fields),input=request(draft);f.engine.approveAndEnqueue(input);
    f.store.pauseGlobal();target.store.restoreRecoverySnapshot(f.store.exportRecoverySnapshot(Date.now()));
    assert.equal(target.engine.approveAndEnqueue(input).replayed,true);
    f.store.close();restarted=new Store(f.directory);
    const engine=new Engine(restarted,new FixturePlanner()),queue=new ExecutionQueue(restarted,engine);
    engine.recover();queue.recover();
    assert.equal(restarted.globalSafetyStatus().paused,true);
    assert.equal(engine.approveAndEnqueue(input).task.queue.state,'CANCELLED');
    assert.equal(restarted.list().length,1);
  } finally {
    if(restarted){restarted.close();rmSync(f.directory,{recursive:true,force:true});}else f.close();
    target.close();
  }
});

test('demo scope is explicit, pinned across edits and cannot silently become fixture',()=>{
  const f=setup({demo:true});
  try {
    const draft=f.engine.draft(fields,f.owner);
    assert.equal(draft.policy.accountId,'demo-account');assert.equal(draft.policy.executionMode,'demo-prepared');
    assert.equal(draft.policy.quoteFeeRateMax,'0.002');assert.equal(draft.policy.campaignHash,f.configuration.campaignHash);
    f.configuration.quoteFeeRateMax='0'; // Caller config cannot mutate the captured constructor scope.
    const edited=f.engine.drafts.edit(f.owner,draft.id,{expectedRevision:1,fields:{maxPrice:'24'}});
    assert.equal(edited.policy.quoteFeeRateMax,'0.002');assert.equal(edited.policy.expiresAtMs,draft.policy.expiresAtMs);
    const unchanged=f.store.policyWorkflow(draft.id,f.owner);
    assert.throws(()=>f.store.updatePolicyWorkflow(draft.id,f.owner,edited.revision,d=>{d.policyContext.campaignId='other';}),/DRAFT_BINDING/);
    assert.deepEqual(f.store.policyWorkflow(draft.id,f.owner),unchanged);
    assert.throws(()=>f.engine.approve(request(edited),f.owner),/approve-and-enqueue/);
    const result=f.engine.approveAndEnqueue(request(edited),f.owner);
    assert.equal(result.task.mode,'demo-prepared');assert.equal(result.task.ledger.phase,'WAITING');
    assert.equal(result.task.ledger.intents.length,0);
    assert.throws(()=>f.store.update(result.task.id,s=>{s.queue.state='RUNNING';}),/dedicated admission/);
    assert.throws(()=>demoPolicyConfiguration({...f.configuration,quoteFeeFixedMax:undefined}));
    assert.throws(()=>demoPolicyConfiguration({...f.configuration,host:'https://example.invalid'}));
  } finally {f.close();}
});

test('demo queue waits for its executor, runs once and never invokes fixture execution',async()=>{
  const f=setup({demo:true});
  try {
    const draft=f.engine.draft(fields,f.owner),input=request(draft);f.engine.approveAndEnqueue(input,f.owner);
    let executor=null,calls=0;
    f.engine.run=async()=>{throw new Error('FIXTURE_MUST_NOT_RUN');};
    const queue=new ExecutionQueue(f.store,f.engine,{demoExecutor:()=>executor});
    await queue.pump();assert.equal(f.store.get(draft.id).queue.state,'QUEUED');
    executor={async run(id){calls++;assert.equal(f.store.get(id).queue.state,'RUNNING');return {code:'DEMO_MODEL_WAIT'};}};
    await queue.pump();assert.equal(calls,1);assert.equal(f.store.get(draft.id).queue.state,'RELEASED');
    f.engine.approveAndEnqueue(input,f.owner);queue.enqueue(draft.id);await queue.pump();assert.equal(calls,1);
    assert.throws(()=>f.store.update(draft.id,s=>{s.queue.state='RUNNING';}),/cannot restart/);
    assert.throws(()=>f.store.update(draft.id,s=>{s.queue.expiresAtMs++;}),/immutable/);
  } finally {f.close();}
});

test('executor failure ends unsent work without retry or fixture fallback',async()=>{
  const f=setup({demo:true});
  try {
    const draft=f.engine.draft(fields,f.owner);f.engine.approveAndEnqueue(request(draft),f.owner);
    let calls=0;
    const queue=new ExecutionQueue(f.store,f.engine,{demoExecutor:()=>({async run(){calls++;throw new Error('TEST_FAILURE');}})});
    await queue.pump();await queue.pump();assert.equal(calls,1);
    assert.equal(f.store.get(draft.id).queue.state,'RELEASED');assert.equal(f.store.get(draft.id).ledger.intents.length,0);
  } finally {f.close();}
});

test('owner revocation and queue expiry prevent a queued demo from starting',async t=>{
  for(const reason of ['owner','deadline']) {
    const f=setup({demo:true});
    try {
      const draft=f.engine.draft(fields,f.owner);f.engine.approveAndEnqueue(request(draft),f.owner);
      const saved=f.store.get(draft.id);let calls=0;
      const queue=new ExecutionQueue(f.store,f.engine,{demoExecutor:()=>({async run(){calls++;}})});
      if(reason==='owner')f.store.revokeSession('token-'+f.owner);
      else t.mock.method(Date,'now',()=>saved.queue.expiresAtMs);
      await queue.pump();assert.equal(calls,0);assert.equal(f.store.get(draft.id).submission,undefined);
      assert.ok(['CANCELLED','RELEASED'].includes(f.store.get(draft.id).queue.state));
    } finally {t.mock.restoreAll();f.close();}
  }
});

test('demo run with exhausted shared quota cannot touch the model or account client',async()=>{
  const f=setup({demo:true});
  try {
    const draft=f.engine.draft(fields,f.owner);f.engine.approveAndEnqueue(request(draft),f.owner);f.store.startDemoQueue(draft.id);
    for(let i=0;i<3;i++)assert.equal(f.store.reserveOwnedModelCall(100,{workflowId:draft.id,ownerId:f.owner,taskId:draft.id,purpose:'proposal'}),true);
    const executor=new DemoExecutor(f.store,{async callJournalledRead(){throw new Error('CLIENT_MUST_NOT_RUN');}});
    assert.equal((await executor.run(draft.id)).code,'MODEL_CALL_LIMIT');await executor.close();
    assert.equal(f.store.get(draft.id).submission,undefined);
  } finally {f.close();}
});

test('approval request tampering is rejected by the audit verifier and on replay',()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields);f.engine.approveAndEnqueue(request(draft));
    const damaged=f.store.get(draft.id);damaged.approvalRequest.expectedRevision++;
    assert.equal(f.store.verifySafetyTask(damaged),false);
    const before=hashCanonical(f.store.get(draft.id));
    assert.throws(()=>f.store.update(draft.id,s=>{s.approvalRequest.expectedRevision++;}),/immutable/);
    assert.equal(hashCanonical(f.store.get(draft.id)),before);
  } finally {f.close();}
});

test('draft discovery returns only owner-scoped metadata and excludes consumed workflows',()=>{
  const f=setup();
  try {
    session(f.store,'other-owner');
    const own=f.engine.draft(fields),other=f.engine.draft(fields,'other-owner');
    assert.deepEqual(f.store.listPolicyWorkflows(f.owner).map(d=>d.id),[own.id]);
    assert.deepEqual(f.store.listPolicyWorkflows('other-owner').map(d=>d.id),[other.id]);
    assert.deepEqual(Object.keys(f.store.listPolicyWorkflows(f.owner)[0]).sort(),['id','ready','revision','validUntilMs']);
    f.engine.approveAndEnqueue(request(own));assert.deepEqual(f.store.listPolicyWorkflows(f.owner),[]);
    assert.equal(f.store.listPolicyWorkflows('other-owner').length,1);
  } finally {f.close();}
});

test('invalid draft projection rolls back before commit and preserves the original approval',()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),before=f.store.policyWorkflow(draft.id,f.owner);
    // Advancing the draft revision without projecting its policy must not persist.
    assert.throws(()=>f.store.updatePolicyWorkflow(draft.id,f.owner,draft.revision,()=>{}),/DRAFT_POLICY_BINDING/);
    assert.deepEqual(f.store.policyWorkflow(draft.id,f.owner),before);
    assert.equal(f.engine.approveAndEnqueue(request(draft)).replayed,false);
  } finally {f.close();}
});

test('invalid initial draft rolls back both its row and workflow quota',()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),id=randomUUID();
    const {taskId,usage,...invalid}=structuredClone(draft);
    Object.assign(invalid,{id,workflowId:id,policy:null});
    assert.throws(()=>f.store.createPolicyWorkflow(invalid),/DRAFT_POLICY_BINDING/);
    assert.throws(()=>f.store.policyWorkflow(id,f.owner),{code:'DRAFT_NOT_FOUND'});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM model_workflows WHERE id=?').get(id).n,0);
    assert.equal(f.store.listPolicyWorkflows(f.owner).length,1);
    assert.equal(f.engine.approveAndEnqueue(request(draft)).replayed,false);
  } finally {f.close();}
});

// Source scenarios only. Not executed; no SDK/network/model dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCampaign} from '../src/domain/campaign.mjs';
import {bindCampaignPolicy,prepareCampaignTask} from '../src/domain/campaign-task.mjs';
import {hashCanonical,hashPolicy} from '../src/domain/governor.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {prepareDemoWireBody} from '../src/adapters/prepared-wire-body.mjs';
import {assessFinalSubmission} from '../src/domain/final-submission.mjs';
import {createSingleDelivery} from '../src/adapters/single-delivery.mjs';
import {Store} from '../src/persistence/store.mjs';

function input(carriedSpent='0') {
  const campaign=createCampaign({id:'campaign',version:1,accountId:'account',connectionVersion:'v1',
    environment:'demo',instrument:'AVAX-USDT',budget:'100',maxShare:'0.5',carriedSpent});
  const policy=bindCampaignPolicy({id:'policy',taskId:'task',accountId:'account',environment:'demo',executionMode:'demo-prepared',
    instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',budget:'100',singleOrderNotionalMax:'25',
    maxPrice:'25',maxShare:'0.5',quoteFeeRateMax:'0.002',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0.002',
    approvedAtMs:1000,expiresAtMs:11000,orderLifetimeMs:5000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:100},campaign);
  const manifest=createDemoConnectionManifest({schemaVersion:1,id:'connection',connectionVersion:'v1',accountId:'account',
    environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
  const task=prepareCampaignTask({policy,approvedPolicyHash:hashPolicy(policy),campaign,ownerId:'owner',nowMs:1200});
  task.revision=1;
  const snapshot={accountId:'account',environment:'demo',instrument:'AVAX-USDT',foreignActivity:false,openOrderCount:0,
    marketAtMs:1100,balanceAtMs:1100,ordersAtMs:1100,tickSize:'0.01',lotSize:'0.1',minSize:'0.1',
    referencePrice:'10',baseBalance:'0',quoteBalance:'1000',availableQuote:'1000'};
  const payload={instId:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',px:'10',sz:'2'};
  const intent={id:'intent',clOrdId:'Pactway001',ordId:null,state:'PREPARED',settled:false,submissionAttempted:false,
    createdAtMs:1100,payload,payloadHash:hashCanonical(payload),policyHash:task.approvedPolicyHash,snapshotHash:hashCanonical(snapshot),
    initialReserve:'20.05',expectedFillQty:null,fills:[]};
  return {task,campaign,peers:[],manifest,intent,snapshot,nowMs:1200,
    prepared:prepareDemoWireBody({manifest,policy,approvedPolicyHash:task.approvedPolicyHash,intent,nowMs:1200})};
}
function rebind(data) {
  data.intent.snapshotHash=hashCanonical(data.snapshot);
  data.prepared=prepareDemoWireBody({manifest:data.manifest,policy:data.task.policy,
    approvedPolicyHash:data.task.approvedPolicyHash,intent:data.intent,nowMs:1200});
}
test('economic success grants no delivery; both budget scopes are independent',()=>{
  const data=input(),result=assessFinalSubmission(data);
  assert.equal(result.ok,true);assert.equal(result.dispatchAllowed,false);assert.equal(result.decision.reserve,'20.05');
  assert.equal(assessFinalSubmission(input('80')).code,'FINAL_CAMPAIGN_BUDGET');
  data.task.ledger.initialSpent='81';
  // Campaign initial spending is forbidden, before an artificial ledger can pass admission.
  assert.equal(assessFinalSubmission(data).ok,false);
});
test('final snapshot changes, stale data, cash, tick and share limits reject',()=>{
  const changed=input();changed.snapshot.availableQuote='1';
  assert.equal(assessFinalSubmission(changed).code,'FINAL_SNAPSHOT_CHANGED');
  rebind(changed);assert.equal(assessFinalSubmission(changed).code,'FINAL_AVAILABLE_QUOTE_CAP');
  const stale=input();stale.snapshot.marketAtMs=0;rebind(stale);stale.nowMs=5001;
  assert.equal(assessFinalSubmission(stale).code,'FINAL_STALE_OR_FUTURE_SNAPSHOT');
  const tick=input();tick.snapshot.tickSize='3';rebind(tick);
  assert.equal(assessFinalSubmission(tick).code,'FINAL_ECONOMICS_CHANGED');
  const share=input();share.snapshot.baseBalance='1000';rebind(share);
  assert.equal(assessFinalSubmission(share).code,'FINAL_POST_FILL_SHARE_CAP');
});
test('prior attempts, stopped tasks, pause, active peers and duplicate client IDs reject',()=>{
  for(const mutate of [d=>d.task.attempts=1,d=>d.task.ledger.stopRequested=true,d=>d.task.submission={},
    d=>d.task.ledger.intents.push(d.intent),d=>d.campaign.paused=true]) {
    const data=input();mutate(data);assert.equal(assessFinalSubmission(data).ok,false);
  }
  const active=input();active.peers=[{id:'other',busy:true,ledger:{intents:[]}}];
  assert.equal(assessFinalSubmission(active).code,'FINAL_EXECUTION_LANE');
  const duplicate=input();duplicate.peers=[{id:'other',policy:{accountId:'account'},ledger:{intents:[{clOrdId:'Pactway001',settled:true}]}}];
  assert.equal(assessFinalSubmission(duplicate).code,'FINAL_CLIENT_ID_REUSED');
});

test('atomic approval requires a running, unexpired queue at the final delivery boundary',()=>{
  const data=input();data.task.approvalRequest={protocol:'APPROVE_AND_ENQUEUE_V1'};
  data.task.queue={state:'QUEUED',enqueuedAtMs:1000,expiresAtMs:1300};
  assert.equal(assessFinalSubmission(data).code,'FINAL_QUEUE_EXPIRED');
  data.task.queue.state='RUNNING';assert.equal(assessFinalSubmission(data).ok,true);
  assert.equal(assessFinalSubmission(data).validUntilMs,1300);
  data.nowMs=1300;assert.equal(assessFinalSubmission(data).code,'FINAL_QUEUE_EXPIRED');
  delete data.task.queue.expiresAtMs;assert.equal(assessFinalSubmission(data).ok,false);
});
test('real Store keeps evidence gate closed and rolls back without marker or reserve',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-final-')),store=new Store(directory);
  try {
    const d=input();store.createCampaign(d.campaign.config);store.create(d.task);
    store.saveSession({tokenHash:'session',ownerId:'owner',csrf:'csrf',expiresAtMs:10000});
    const before=store.get('task'),receipts=store.receipts('task').length;
    const request={taskId:'task',expectedRevision:before.revision,manifest:d.manifest,intent:d.intent,
      prepared:d.prepared,snapshot:d.snapshot};
    assert.throws(()=>store.commitDemoSubmission(request,()=>1200),{code:'FINAL_EVIDENCE_NOT_CONNECTED'});
    assert.deepEqual(store.get('task'),before);assert.equal(store.receipts('task').length,receipts);
    assert.equal(store.campaign('campaign').summary.reserved,'0');
    assert.throws(()=>store.commitDemoSubmission({...request,expectedRevision:0},()=>1200),{code:'FINAL_TASK_CHANGED'});
    store.pauseGlobal();assert.throws(()=>store.commitDemoSubmission(request,()=>1200),{code:'GLOBAL_PAUSED'});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('orchestration invokes once after commit; response loss never retries',async()=>{
  const events=[];let claimed=false;
  // Fake dependencies exercise sequencing ONLY, not evidence or SQLite durability.
  const store={commitDemoSubmission(){if(claimed)throw new Error('already claimed');claimed=true;events.push('commit');
    return {taskId:'task',commitmentHash:'hash',checkedAtMs:1200,validUntilMs:1300,bodyText:'exact bytes'};},
    markDemoSubmissionUnknown(){events.push('unknown');},pauseGlobal(){events.push('pause');}};
  const deliver=createSingleDelivery({store,clock:()=>1200,transport:packet=>{
    events.push('transport');assert.equal(packet.bodyText,'exact bytes');throw new Error('socket lost');}});
  assert.equal((await deliver({})).code,'DELIVERY_OUTCOME_UNKNOWN');
  await assert.rejects(deliver({}),/already claimed/);assert.deepEqual(events,['commit','transport','unknown']);
});
test('expired post-commit window never invokes transport or releases marker',async()=>{
  let calls=0,unknown=0;
  const deliver=createSingleDelivery({clock:()=>1300,transport:()=>calls++,store:{
    commitDemoSubmission:()=>({checkedAtMs:1200,validUntilMs:1300}),markDemoSubmissionUnknown:()=>unknown++,pauseGlobal(){}}});
  const result=await deliver({});assert.equal(result.code,'DELIVERY_WINDOW_EXPIRED');
  assert.equal(calls,0);assert.equal(unknown,1);assert.equal(result.retryAllowed,false);
});

// Acceptance sources only; not run. No live account, SDK or model invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {createCampaign,projectCampaign} from '../src/domain/campaign.mjs';
import {bindCampaignPolicy,prepareCampaignTask} from '../src/domain/campaign-task.mjs';
import {hashPolicy,hashCanonical} from '../src/domain/governor.mjs';
import {createLedger} from '../src/domain/ledger.mjs';
import {createTaskId} from '../src/audit/commitments.mjs';
import {Engine} from '../src/engine.mjs';

const config={id:'campaign',version:1,accountId:'shared-demo',connectionVersion:'connection-v1',environment:'demo',instrument:'AVAX-USDT',budget:'100',maxShare:'0.2'};
const base=(id='task')=>({id:'policy-'+id,taskId:id,accountId:config.accountId,environment:'demo',executionMode:'demo-prepared',
  instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',budget:'25',singleOrderNotionalMax:'20',maxPrice:'25',maxShare:'0.1',
  quoteFeeRateMax:'0.002',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0.002',approvedAtMs:100,expiresAtMs:10000,
  orderLifetimeMs:1000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:2000});
function withStore(operation) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-campaign-')),store=new Store(directory);
  try {return operation(store);} finally {store.close();rmSync(directory,{recursive:true,force:true});}
}
test('policy binds before approval; task starts at zero and WAITING',()=>{
  const campaign=createCampaign(config),policy=bindCampaignPolicy(base(),campaign);
  const state=prepareCampaignTask({policy,approvedPolicyHash:hashPolicy(policy),campaign,ownerId:'owner',nowMs:200});
  assert.equal(policy.campaignHash,campaign.configHash);assert.equal(Object.isFrozen(policy),true);
  assert.equal(state.ledger.initialSpent,'0');assert.equal(state.ledger.phase,'WAITING');assert.deepEqual(state.ledger.intents,[]);
  assert.equal(state.mode,'demo-prepared');assert.equal(state.ownerId,'owner');
});
test('old approval cannot survive campaign replacement, expiry or modified policy',()=>{
  const campaign=createCampaign(config),policy=bindCampaignPolicy(base(),campaign);
  const input={policy,approvedPolicyHash:hashPolicy(policy),campaign,ownerId:'owner',nowMs:200};
  assert.throws(()=>prepareCampaignTask({...input,campaign:createCampaign({...config,version:2})}),/BINDING_CHANGED/);
  assert.throws(()=>prepareCampaignTask({...input,nowMs:10000}),/EXPIRED/);
  assert.throws(()=>prepareCampaignTask({...input,policy:{...policy,budget:'26'}}),/APPROVAL/);
  assert.throws(()=>bindCampaignPolicy({...base(),executionMode:'fixture'},campaign),/SCOPE/);
  assert.throws(()=>bindCampaignPolicy({...base(),maxShare:'0.3'},campaign),/LIMIT/);
  assert.throws(()=>bindCampaignPolicy({...base(),budget:'101'},campaign),/LIMIT/);
});
test('persisted preparation preserves approval and cannot enter fixture execution',()=>withStore(store=>{
  const campaign=store.createCampaign(config),policy=bindCampaignPolicy(base(),campaign);
  const state=store.createPreparedCampaignTask({campaignId:config.id,policy,approvedPolicyHash:hashPolicy(policy),ownerId:'owner',nowMs:200});
  assert.equal(state.ledger.phase,'WAITING');assert.equal(store.campaign(config.id).summary.spent,'0');
  assert.throws(()=>store.update(state.id,s=>{s.policy.budget='26';}),/approval mismatch/);
  assert.throws(()=>store.update(state.id,s=>{s.ownerId='different';}),/cannot be changed/);
  assert.throws(()=>store.update(state.id,s=>{s.queue={state:'QUEUED'};}),/dedicated admission/);
  assert.equal(store.get(state.id).queue,undefined);assert.equal(store.get(state.id).ownerId,'owner');
  const engine=new Engine(store,{kind:'unused'});
  assert.throws(()=>engine.snapshot(state),/henüz hazır değil/);
}));

function fixture(id) {
  const policy={...base(id),executionMode:'fixture',accountId:'fixture-'+id};
  return {id,ownerId:'owner',auditTaskId:createTaskId(id),policy,approvedPolicyHash:hashPolicy(policy),mode:'fixture',busy:false,
    ledger:createLedger({taskId:id,accountId:policy.accountId,budget:policy.budget})};
}
test('queue capacity and worker slot are enforced inside Store transaction with rollback',()=>withStore(store=>{
  for(const id of ['a','b','c','d'])store.create(fixture(id));
  for(const id of ['a','b','c'])store.update(id,s=>{s.queue={state:'QUEUED'};});
  const before=store.get('d').revision;
  assert.throws(()=>store.update('d',s=>{s.queue={state:'QUEUED'};}),/Queue capacity/);
  assert.equal(store.get('d').revision,before);assert.equal(store.get('d').queue,undefined);
  store.update('a',s=>{s.queue.state='RUNNING';});
  assert.throws(()=>store.update('b',s=>{s.queue.state='RUNNING';}),/lane is occupied/);
  assert.equal(store.get('b').queue.state,'QUEUED');
}));

function reservedState(id,accountId,reserve='10') {
  const state=fixture(id);state.policy.accountId=accountId;state.ledger.accountId=accountId;
  state.approvedPolicyHash=hashPolicy(state.policy);
  const payload={instId:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',px:'10',sz:'1'};
  state.ledger.intents=[{id:'intent-'+id,clOrdId:'order'+id,ordId:null,state:'PREPARED',settled:false,submissionAttempted:false,
    payload,payloadHash:hashCanonical(payload),initialReserve:reserve,fills:[]}];
  return state;
}
test('account slot and task budget reject new authority without partial persistence',()=>withStore(store=>{
  store.create(reservedState('first','same-account'));
  assert.throws(()=>store.create(reservedState('second','same-account')),/Account intent slot/);
  assert.equal(store.get('second'),null);assert.equal(store.receipts('second').length,0);
  assert.throws(()=>store.create(reservedState('cost','other-account','26')),/Task budget/);
  assert.equal(store.get('cost'),null);
  store.update('first',s=>{s.ledger.intents[0].state='UNKNOWN';});
  store.create(fixture('waiting'));
  assert.throws(()=>store.update('waiting',s=>{s.queue={state:'QUEUED'};}),/Unresolved execution/);
  assert.equal(store.get('waiting').queue,undefined);
}));

test('campaign rejects repeated tasks and cross-task trade reuse even with equal intent IDs',()=>{
  const campaign=createCampaign(config);
  const make=id=>{
    const state=reservedState(id,config.accountId);
    state.campaignId=config.id;
    Object.assign(state.policy,{campaignId:config.id,campaignVersion:1,campaignHash:campaign.configHash,connectionVersion:config.connectionVersion});
    state.ledger.intents[0].id='same-intent';
    state.ledger.intents[0].fills=[{tradeId:'same-trade',baseQty:'0.1',quoteNotional:'1',feeQuote:'0',feeBase:'0'}];
    return state;
  };
  const first=make('one'),second=make('two');
  assert.throws(()=>projectCampaign(campaign,[first,first]),/task identity repeated/);
  assert.throws(()=>projectCampaign(campaign,[first,second]),/trade ID belongs to another intent/);
  first.ledger.intents[0].fills.push({...first.ledger.intents[0].fills[0]});
  assert.throws(()=>projectCampaign(campaign,[first]),/trade identity missing or repeated/);
});

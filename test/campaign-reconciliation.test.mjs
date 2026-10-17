// Source acceptance scenarios only. Not executed; no SDK/network/runtime checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCampaign} from '../src/domain/campaign.mjs';
import {createBalanceCheckpoint,reconcileCampaignBalances} from '../src/domain/campaign-reconciliation.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {Store} from '../src/persistence/store.mjs';
import {hashPolicy,hashCanonical} from '../src/domain/governor.mjs';
import {createTaskId} from '../src/audit/commitments.mjs';
const now=1770000000000;
const config={id:'campaign',version:1,accountId:'shared',connectionVersion:'v1',environment:'demo',instrument:'AVAX-USDT',budget:'100',maxShare:'0.5'};
const binding={connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),sessionId:'session',accountId:'shared'};
function observation(tool,rows,at) {
  const envelope={tool,ok:true,data:{endpoint:'GET /api/v5/account/'+(tool==='account_get_config'?'config':'balance'),
    requestTime:new Date(at).toISOString(),data:rows},timestamp:new Date(at).toISOString(),
    capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{account:{status:'enabled'}}}};
  const prepared=prepareATKObservation({schemaVersion:1,...binding,observationId:tool+'-'+at,callId:tool+'-'+at,
    taskId:null,intentId:null,tool,args:{},requestedAtMs:at,receivedAtMs:at},{structuredContent:envelope});
  assert.equal(prepared.ok,true);return prepared.record;
}
function supplied(avax,usdt,at=now) {
  const asset=(ccy,value)=>({ccy,uTime:String(at),eq:value,cashBal:value,availBal:value,frozenBal:'0',ordFrozen:'0',
    liab:'0',crossLiab:'0',interest:'0',borrowFroz:'0',fixedBal:'0',stgyEq:'0',spotIsoBal:'0',smtSyncEq:'0',spotCopyTradingEq:'0'});
  return {balanceRecord:observation('account_get_balance',[{uTime:String(at),imr:'0',mmr:'0',borrowFroz:'0',notionalUsd:'0',
    details:[asset('AVAX',avax),asset('USDT',usdt)]}],at),
    options:{expectedBinding:binding,nowMs:at,maxAgeMs:5000,maxSkewMs:100,
      accountConfigRecord:observation('account_get_config',[{acctLv:'1',enableSpotBorrow:false,autoLoan:false,spotBorrowAutoRepay:false,feeType:'0',uid:'123'}],at)}};
}
function settled(campaign) {
  const policy={id:'policy',taskId:'task',accountId:'shared',environment:'demo',executionMode:'fixture',instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
    budget:'50',singleOrderNotionalMax:'30',maxPrice:'10',maxShare:'0.5',quoteFeeRateMax:'0.01',baseFeeRateMax:'0.1',quoteFeeFixedMax:'0',
    approvedAtMs:now-100,expiresAtMs:now+10000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:100,
    campaignId:campaign.config.id,campaignVersion:campaign.config.version,campaignHash:campaign.configHash,connectionVersion:'v1'};
  const payload={instId:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',px:'10',sz:'2'};
  return {id:'task',auditTaskId:createTaskId('task'),ownerId:'owner',campaignId:campaign.config.id,mode:'fixture',busy:false,
    policy,approvedPolicyHash:hashPolicy(policy),ledger:{taskId:'task',accountId:'shared',budget:'50',initialSpent:'0',phase:'WAITING',stopRequested:false,
      intents:[{id:'intent',clOrdId:'clientorder',ordId:'123',payload,payloadHash:hashCanonical(payload),initialReserve:'21',
        state:'FILLED',submissionAttempted:true,settled:true,fills:[{tradeId:'trade',baseQty:'2',quoteNotional:'20',feeBase:'0.1',feeQuote:'0.2',feesComplete:true}]}]}};
}
test('owned acquisition and both fee currencies explain cash; no authority is implied',()=>{
  const campaign=createCampaign(config),baseline=createBalanceCheckpoint({campaign,states:[],...supplied('1','100')});
  const view=reconcileCampaignBalances({campaign,states:[settled(campaign)],baseline,...supplied('2.9','79.8',now+1)});
  assert.equal(view.status,'MATCHED_KNOWN_FILLS');assert.equal(view.requiresPause,false);
  assert.equal(view.ready,false);assert.equal(view.foreignActivity,'UNKNOWN');assert.equal(view.coverageVerified,false);
  const changed=reconcileCampaignBalances({campaign,states:[settled(campaign)],baseline,...supplied('2.9','80.8',now+1)});
  assert.equal(changed.difference.USDT,'1');assert.equal(changed.requiresPause,true);
});
test('pre-baseline fills are not counted twice; removal, unfinished fees and stale checkpoint fail closed',()=>{
  const campaign=createCampaign(config),state=settled(campaign);
  const baseline=createBalanceCheckpoint({campaign,states:[state],...supplied('2.9','79.8')});
  assert.equal(reconcileCampaignBalances({campaign,states:[state],baseline,...supplied('2.9','79.8',now+1)}).requiresPause,false);
  assert.equal(reconcileCampaignBalances({campaign,states:[],baseline,...supplied('2.9','79.8',now+1)}).code,'BALANCE_PRIOR_FILL_MISSING');
  assert.equal(reconcileCampaignBalances({campaign,states:[state],baseline,...supplied('2.9','79.8')}).code,'BALANCE_OBSERVATION_NOT_NEWER');
  state.ledger.intents[0].fills[0].feesComplete=false;
  assert.equal(reconcileCampaignBalances({campaign,states:[state],baseline,...supplied('2.9','79.8',now+1)}).requiresPause,true);
});
function withStore(fn) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-reconcile-')),store=new Store(directory);
  try{fn(store);}finally{store.close();rmSync(directory,{recursive:true,force:true});}
}
test('mismatch persists pause and evidence; later match cannot clear it or reset baseline',()=>withStore(store=>{
  store.createCampaign(config);store.establishCampaignBalanceBaseline(config.id,supplied('1','100'));
  const result=store.reconcileCampaignBalance(config.id,supplied('1','101',now+1));
  assert.equal(result.campaign.paused,true);
  store.reconcileCampaignBalance(config.id,supplied('1','100',now+2));
  assert.equal(store.campaign(config.id).paused,true);
  assert.throws(()=>store.establishCampaignBalanceBaseline(config.id,supplied('1','101',now+3)),/cannot be overwritten/);
  assert.throws(()=>store.openCampaignForPreparation(config.id),/cannot be reopened/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM campaign_events').get().n,3);
}));
test('renewal preserves spend, old policies, and late evidence pauses the successor',()=>withStore(store=>{
  const campaign=store.createCampaign(config);store.create(settled(campaign));store.pauseCampaign(config.id);
  store.renewCampaign(config.id,{newId:'next',budget:'100',maxShare:'0.5',expectedConfigHash:campaign.configHash});
  assert.equal(store.campaign('next').summary.spent,'20.2');assert.equal(store.campaign('next').summary.remaining,'79.8');
  assert.equal(store.campaign('next').paused,true);assert.equal(store.get('task').policy.campaignId,config.id);
  assert.throws(()=>store.openCampaignForPreparation(config.id),/cannot be reopened/);
  store.openCampaignForPreparation('next');
  store.update('task',state=>{state.ledger.intents[0].fills.push({tradeId:'late',baseQty:'0.01',quoteNotional:'0.1',feeBase:'0',feeQuote:'0',feesComplete:true});});
  assert.equal(store.campaign('next').paused,true);
  assert.equal(store.campaign('next').violations[0].code,'PREDECESSOR_ECONOMICS_CHANGED');
  assert.equal(store.campaign(config.id).summary.spent,'20.3');
}));
test('renewal fails atomically for stale hash, unsettled execution or duplicate successor ID',()=>withStore(store=>{
  const campaign=store.createCampaign(config);store.pauseCampaign(config.id);
  assert.throws(()=>store.renewCampaign(config.id,{newId:'next',budget:'100',maxShare:'0.5',expectedConfigHash:'wrong'}),/blocked/);
  assert.equal(store.campaign('next'),null);
  store.createCampaign({...config,id:'existing'});
  assert.throws(()=>store.renewCampaign(config.id,{newId:'existing',budget:'100',maxShare:'0.5',expectedConfigHash:campaign.configHash}));
  assert.equal(store.campaign(config.id).supersededBy,undefined);
}));
test('UNKNOWN prevents campaign renewal without releasing its reserve',()=>withStore(store=>{
  const campaign=store.createCampaign(config),state=settled(campaign);
  state.ledger.intents[0].settled=false;state.ledger.intents[0].state='UNKNOWN';
  store.create(state);store.pauseCampaign(config.id);
  const reserved=store.campaign(config.id).summary.reserved;
  assert.throws(()=>store.renewCampaign(config.id,{newId:'next',budget:'100',maxShare:'0.5',expectedConfigHash:campaign.configHash}),/blocked/);
  assert.equal(store.campaign('next'),null);assert.equal(store.campaign(config.id).summary.reserved,reserved);
}));

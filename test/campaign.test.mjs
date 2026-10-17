// Acceptance sources only; not run. No real shared account or ATK connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {createLedger,prepareIntent,markSubmitting,recordFill} from '../src/domain/ledger.mjs';
import {hashPolicy,evaluateCandidate} from '../src/domain/governor.mjs';
import {createTaskId} from '../src/audit/commitments.mjs';
import {hasForeignActivity} from '../src/domain/campaign.mjs';

test('campaign reservation is atomic with tasks; observed over-cost pauses instead of being dropped',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mg-campaign-')),store=new Store(directory);
  try {
    const campaign=store.createCampaign({id:'campaign',version:1,connectionVersion:'fixture-v1',accountId:'shared-fixture',
      environment:'demo',instrument:'AVAX-USDT',budget:'15',maxShare:'0.1'});
    function state(id) {
      const policy={id:'policy-'+id,taskId:id,accountId:'shared-fixture',environment:'demo',instrument:'AVAX-USDT',side:'buy',
        tdMode:'cash',ordType:'limit',budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
        quoteFeeRateMax:'0',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0',approvedAtMs:0,expiresAtMs:10000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:2000,
        campaignId:'campaign',campaignVersion:1,campaignHash:campaign.configHash,connectionVersion:'fixture-v1'};
      let ledger=createLedger({taskId:id,accountId:'shared-fixture',budget:'100'});
      const snapshot={accountId:'shared-fixture',environment:'demo',instrument:'AVAX-USDT',foreignActivity:false,openOrderCount:0,
        baseBalance:'0',quoteBalance:'500',availableQuote:'500',referencePrice:'25',tickSize:'0.01',lotSize:'0.0001',minSize:'0.0001',
        marketAtMs:100,balanceAtMs:100,ordersAtMs:100};
      const decision=evaluateCandidate({policy,approvedPolicyHash:hashPolicy(policy),snapshot,
        candidate:{instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.396'},ledgerSummary:{...ledger,spent:'0',reserved:'0',localReserved:'0',activeIntentCount:0},nowMs:100});
      ledger=markSubmitting(prepareIntent(ledger,{id:'intent-'+id,clOrdId:'order'+id,decision,createdAtMs:100}),'intent-'+id);
      return {id,auditTaskId:createTaskId(id),campaignId:'campaign',policy,ledger};
    }
    store.create(state('a'));
    assert.equal(store.campaign('campaign').summary.reserved,'9.91');
    assert.throws(()=>store.create(state('b')),/Campaign execution is blocked|Account intent slot is occupied/);
    assert.equal(store.get('b'),null);assert.equal(store.campaign('campaign').summary.reserved,'9.91');
    store.update('a',task=>{task.ledger=recordFill(task.ledger,'intent-a',{tradeId:'trade',baseQty:'0.1',quoteNotional:'20',feeQuote:'0',feeBase:'0',feesComplete:true});});
    const observed=store.campaign('campaign');
    assert.equal(observed.summary.spent,'20');assert.equal(observed.paused,true);
    assert.equal(hasForeignActivity({campaign:observed,complete:true,accountId:'shared-fixture',instrument:'AVAX-USDT',fills:[{clOrdId:'ordera'}]}),false);
    assert.equal(hasForeignActivity({campaign:observed,complete:true,accountId:'shared-fixture',instrument:'AVAX-USDT',fills:[{clOrdId:'external'}]}),true);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

// Not executed. Real local Store captures + pure evidence reconstruction only;
// these synthetic records are NOT a demo runtime or an exchange acceptance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/persistence/store.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {deriveDemoSnapshot,durableRecord,evidenceIds,verifyDemoLimits,verifyDemoCash,verifyDemoBaseline} from '../src/domain/demo-evidence.mjs';
import {hashCanonical} from '../src/domain/governor.mjs';

const nowMs=1770000000000;
const binding={connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),sessionId:'session',accountId:'account'};
const asset=(ccy,cash)=>({ccy,uTime:String(nowMs),eq:cash,cashBal:cash,availBal:cash,eqUsd:cash,
  frozenBal:'0',ordFrozen:'0',liab:'0',crossLiab:'0',interest:'0',borrowFroz:'0',fixedBal:'0',stgyEq:'0',
  spotIsoBal:'0',smtSyncEq:'0',spotCopyTradingEq:'0'});
function fixture({supplied=false,open=false,usd='1000',endingCash='1000',rebate=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-evidence-')),store=new Store(directory);
  const session=store.openATKCaptureSession(binding);
  const e={endMs:nowMs};
  function add(id,tool,path,args,rows) {
    const prepared=prepareATKObservation({schemaVersion:1,...binding,observationId:id,callId:'call-'+id,
      taskId:null,intentId:null,tool,args,requestedAtMs:nowMs,receivedAtMs:nowMs},
    {structuredContent:{tool,ok:true,data:{endpoint:'GET /api/v5/'+path,requestTime:new Date(nowMs).toISOString(),data:rows},
      capabilities:{readOnly:false,hasAuth:true,demo:true,moduleAvailability:{[tool.split('_')[0]]:{status:'enabled'}}},
      timestamp:new Date(nowMs).toISOString()}});
    assert.equal(prepared.ok,true);
    if(supplied)store.captureATKToolObservation(prepared.record);else session.capture(prepared.record);
    return id;
  }
  const config=[{acctLv:'1',enableSpotBorrow:false,autoLoan:false,spotBorrowAutoRepay:false,feeType:'0',uid:'123'}];
  const balance=cash=>[{uTime:String(nowMs),imr:'0',mmr:'0',borrowFroz:'0',notionalUsd:'0',
    details:[asset('AVAX','1'),{...asset('USDT',cash),eqUsd:usd}]}];
  e.configStartId=add('config-start','account_get_config','account/config',{},config);
  e.balanceStartId=add('balance-start','account_get_balance','account/balance',{},balance('1000'));
  e.instrumentId=add('instrument','market_get_instruments','public/instruments',{instType:'SPOT',instId:'AVAX-USDT',demo:true},
    [{instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',ruleType:'normal',groupId:'1',upcChg:[],
      tickSz:'0.01',lotSz:'0.1',minSz:'0.1',maxLmtSz:'100',maxLmtAmt:'1000'}]);
  e.tickerId=add('ticker','market_get_ticker','market/ticker',{instId:'AVAX-USDT',demo:true},
    [{instId:'AVAX-USDT',instType:'SPOT',askPx:'10',askSz:'20',ts:String(nowMs)}]);
  e.feeId=add('fee','account_get_trade_fee','account/trade-fee',{instType:'SPOT',instId:'AVAX-USDT'},
    [{instType:'SPOT',ts:String(nowMs),feeGroup:[{groupId:'1',maker:rebate?'0.001':'-0.001',taker:'-0.002'}]}]);
  e.openStartId=add('open-start','spot_get_orders','trade/orders-pending',{status:'open',limit:100},open?[{ordId:'1'}]:[]);
  e.algoIds=['conditional','oco','move_order_stop'].map(ordType=>add('algo-'+ordType,'spot_get_algo_orders','trade/orders-algo-pending',
    {status:'pending',ordType,limit:100},[]));
  const range={begin:String(nowMs-3600000),end:String(nowMs),limit:100};
  e.orderIds=[add('orders','spot_get_orders','trade/orders-history',{status:'history',...range},[])];
  e.fillIds=[add('fills','spot_get_fills','trade/fills',{archive:false,...range},[])];
  e.openEndId=add('open-end','spot_get_orders','trade/orders-pending',{status:'open',limit:100},[]);
  e.configId=add('config','account_get_config','account/config',{},config);
  e.balanceId=add('balance','account_get_balance','account/balance',{},balance(endingCash));
  const context={binding,manifest:{config:{connectionVersion:'v1'}},identityObservationId:e.configId};
  return {directory,store,session,context,evidence:e,nowMs,baseline:true};
}
function cleanup(f){f.store.close();rmSync(f.directory,{recursive:true,force:true});}

test('captured bracketed account evidence derives economics without accepting authority flags',()=>{
  const f=fixture();
  try {
    const snapshot=deriveDemoSnapshot(f);
    assert.equal(snapshot.availableQuote,'1000');assert.equal(snapshot.baseBalance,'1');
    assert.equal(snapshot.source,'REGISTERED_DEMO_RUNTIME');assert.equal(evidenceIds(snapshot.evidence).length,14);
    assert.throws(()=>evidenceIds({...f.evidence,complete:true}),{code:'FINAL_EVIDENCE_INPUT'});
    assert.throws(()=>f.store.attachDemoRuntime({executionContext(){return f.context;}}));
  } finally {cleanup(f);}
});
test('supplied JSON, closed session, open orders, changing cash and rebates fail closed',()=>{
  for(const [options,code] of [[{supplied:true},'LIFECYCLE_SOURCE_REQUIRED'],[{open:true},'FINAL_OPEN_ORDERS'],
    [{endingCash:'999'},'FINAL_BALANCE_CHANGED_OR_FROZEN'],[{rebate:true},'FINAL_REBATE_UNSUPPORTED'],
    [{usd:'0'},'FINAL_USD_VALUATION_REQUIRED']]) {
    const f=fixture(options);
    try {assert.throws(()=>deriveDemoSnapshot(f),{code});} finally {cleanup(f);}
  }
  const f=fixture();
  try {f.session.close();assert.throws(()=>durableRecord(f.store,f.evidence.configId,f.context,{nowMs}),{code:'LIFECYCLE_SOURCE_REQUIRED'});}
  finally {cleanup(f);}
});
test('instrument USD cap uses observed quote valuation and fee limits stay conservative',()=>{
  const f=fixture();
  try {
    const snapshot=deriveDemoSnapshot(f),policy={quoteFeeRateMax:'0.002',baseFeeRateMax:'0.002'};
    assert.doesNotThrow(()=>verifyDemoLimits(snapshot,policy,{payload:{px:'10',sz:'2'}}));
    assert.throws(()=>verifyDemoLimits({...snapshot,quoteUsdValue:'2000'},policy,{payload:{px:'10',sz:'60'}}),{code:'FINAL_INSTRUMENT_LIMIT'});
    assert.throws(()=>verifyDemoLimits(snapshot,{...policy,quoteFeeRateMax:'0'}, {payload:{px:'10',sz:'2'}}),{code:'FINAL_FEE_BOUND'});
  } finally {cleanup(f);}
});
test('net base and quote fees are reconciled once against immutable baseline',()=>{
  const body={balances:{AVAX:'1',USDT:'1000'},fills:[]},baseline={...body,checkpointHash:hashCanonical(body)};
  const states=[{ledger:{intents:[{fills:[{tradeId:'1',baseQty:'2',quoteNotional:'20',feeQuote:'0.04',feeBase:'0',feesComplete:true}]}]}}];
  const balance={balances:{AVAX:{cash:'3'},USDT:{cash:'979.96'}}};
  assert.doesNotThrow(()=>verifyDemoCash(baseline,states,balance));
  assert.throws(()=>verifyDemoCash(baseline,states,{balances:{AVAX:{cash:'3'},USDT:{cash:'980'}}}),{code:'FINAL_UNEXPLAINED_BALANCE'});
  assert.throws(()=>verifyDemoCash({...baseline,balances:{AVAX:'1',USDT:'2000'}},states,balance),{code:'FINAL_BASELINE_CHANGED'});
});
test('a generic baseline is not execution provenance; original capture receipts remain mandatory',()=>{
  for(const supplied of [false,true]) {
    const f=fixture({supplied});
    try {
      const campaign=f.store.createCampaign({id:'campaign',accountId:'account',connectionVersion:'v1',version:1,
        environment:'demo',instrument:'AVAX-USDT',budget:'100',maxShare:'0.5'});
      const saved=f.store.establishCampaignBalanceBaseline(campaign.config.id,{
        balanceRecord:f.store.atkToolObservation(f.evidence.balanceId).record,
        options:{expectedBinding:binding,nowMs,maxAgeMs:15000,maxSkewMs:15000,
          accountConfigRecord:f.store.atkToolObservation(f.evidence.configId).record}}).campaign;
      assert.throws(()=>verifyDemoBaseline(f.store,saved,f.context),{code:'FINAL_BASELINE_SOURCE_REQUIRED'});
      // Explicit DB fixture only: emulate the event written by the branded
      // runtime path. This does not exercise or attest that runtime.
      f.store.db.prepare('INSERT INTO campaign_events(campaign_id,kind,at_ms,record) VALUES(?,?,?,?)')
        .run(campaign.config.id,'DEMO_BALANCE_BASELINE',nowMs,
          JSON.stringify({checkpointHash:saved.balanceBaseline.checkpointHash,evidence:f.evidence}));
      f.store.db.exec("UPDATE atk_tool_observations SET status='APPLIED'");
      f.session.close();
      if(supplied)assert.throws(()=>verifyDemoBaseline(f.store,saved,f.context),{code:'FINAL_BASELINE_SOURCE_REQUIRED'});
      else {
        assert.equal(verifyDemoBaseline(f.store,saved,f.context).checkpointHash,saved.balanceBaseline.checkpointHash);
        f.store.db.prepare("UPDATE atk_tool_observations SET status='QUARANTINED' WHERE observation_id=?").run(f.evidence.feeId);
        assert.throws(()=>verifyDemoBaseline(f.store,saved,f.context),{code:'FINAL_BASELINE_SOURCE_REQUIRED'});
      }
    } finally {cleanup(f);}
  }
});
test('pre-baseline fills cannot disappear or silently change their economics',()=>{
  const fill={tradeId:'1',baseQty:'2',quoteNotional:'20',feeQuote:'0.04',feeBase:'0',feesComplete:true};
  const states=[{id:'task',ledger:{intents:[{id:'intent',fills:[fill]}]}}];
  const body={balances:{AVAX:'3',USDT:'979.96'},fills:[{taskId:'task',intentId:'intent',tradeId:'1',baseNet:'2',quoteCost:'20.04'}]};
  const baseline={...body,checkpointHash:hashCanonical(body)};
  const balance={balances:{AVAX:{cash:'3'},USDT:{cash:'979.96'}}};
  assert.doesNotThrow(()=>verifyDemoCash(baseline,states,balance));
  assert.throws(()=>verifyDemoCash(baseline,[],balance),{code:'FINAL_BASELINE_FILL_CHANGED'});
  states[0].ledger.intents[0].fills[0]={...fill,feeQuote:'0.05'};
  assert.throws(()=>verifyDemoCash(baseline,states,balance),{code:'FINAL_BASELINE_FILL_CHANGED'});
});

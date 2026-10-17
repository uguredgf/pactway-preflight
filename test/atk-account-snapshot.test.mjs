// Source acceptance cases only; not executed. No SDK/network/Store invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {assembleDemoAccountSnapshot} from '../src/adapters/atk-account-snapshot.mjs';

const nowMs=1770000000000;
const binding={connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),sessionId:'s1',accountId:'demo'};
function record(id,tool,path,args,rows,at=nowMs,patch={}) {
  const envelope={tool,ok:true,data:{endpoint:'GET /api/v5/'+path,requestTime:new Date(at).toISOString(),data:rows},
    capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{[tool.split('_')[0]]:{status:'enabled'}}},timestamp:new Date(at).toISOString()};
  const prepared=prepareATKObservation({schemaVersion:1,...binding,observationId:id,callId:id,taskId:null,intentId:null,
    tool,args,requestedAtMs:at,receivedAtMs:at,...patch},{structuredContent:envelope});
  assert.equal(prepared.ok,true);return prepared.record;
}
const asset=ccy=>({ccy,uTime:String(nowMs),eq:'10',cashBal:'10',availBal:'10',frozenBal:'0',ordFrozen:'0',liab:'0',
  crossLiab:'0',interest:'0',borrowFroz:'0',fixedBal:'0',stgyEq:'0',spotIsoBal:'0',smtSyncEq:'0',spotCopyTradingEq:'0'});
function fixture() {
  const range={begin:String(nowMs-600000),end:String(nowMs),limit:2};
  return {expectedBinding:binding,nowMs,maxAgeMs:10000,maxSkewMs:100,beginMs:nowMs-600000,endMs:nowMs,pageSize:2,
    instrumentRecord:record('instrument','market_get_instruments','public/instruments',{instType:'SPOT',instId:'AVAX-USDT',demo:true},[
      {instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',ruleType:'normal',groupId:'1',upcChg:[],tickSz:'0.01',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000',maxLmtAmt:'100000'}]),
    tickerRecord:record('ticker','market_get_ticker','market/ticker',{instId:'AVAX-USDT',demo:true},[
      {instId:'AVAX-USDT',instType:'SPOT',askPx:'10',askSz:'1',ts:String(nowMs)}]),
    configRecord:record('config','account_get_config','account/config',{},[
      {acctLv:'1',enableSpotBorrow:false,autoLoan:false,spotBorrowAutoRepay:false,feeType:'0',uid:'123'}]),
    balanceRecord:record('balance','account_get_balance','account/balance',{},[
      {uTime:String(nowMs),imr:'0',mmr:'0',borrowFroz:'0',notionalUsd:'0',details:[asset('AVAX'),asset('USDT')]}]),
    feeRecord:record('fees','account_get_trade_fee','account/trade-fee',{instType:'SPOT',instId:'AVAX-USDT'},[
      {instType:'SPOT',ts:String(nowMs),feeGroup:[{groupId:'1',maker:'-0.001',taker:'-0.002'}]}]),
    histories:{
      openOrders:[record('open','spot_get_orders','trade/orders-pending',{status:'open',limit:2},[])],
      orders:[record('orders','spot_get_orders','trade/orders-history',{status:'history',...range},[])],
      fills:[record('fills','spot_get_fills','trade/fills',{archive:false,...range},[])],
    }};
}
function blocked(value) {
  for (const key of ['ready','complete','accountComplete','economicComplete','launchAllowed','readAuthorized','writeEnabled','routeVerified','actualAccountVerified'])
    assert.equal(value[key],false,key);
  assert.equal(value.foreignActivity,'UNKNOWN');assert.ok(value.requiredBlockers.length);
}
test('coherent empty transcripts prepare a detached diagnostic snapshot without authority',()=>{
  const input=fixture(),view=assembleDemoAccountSnapshot(input);
  assert.equal(view.ok,true);assert.equal(view.references.length,8);assert.equal(view.balances.USDT.available,'10');blocked(view);
  assert.equal(Object.isFrozen(view.histories.fills.rows),true);
  input.histories.fills.length=0;assert.equal(view.histories.fills.pages,1);
});
test('cross-record span rejects individually fresh observations',()=>{
  const input=fixture();input.histories.openOrders=[record('open','spot_get_orders','trade/orders-pending',{status:'open',limit:2},[],nowMs-101)];
  const view=assembleDemoAccountSnapshot(input);assert.equal(view.code,'ATK_SNAPSHOT_SKEW');blocked(view);
  assert.equal(Object.hasOwn(view,'balances'),false);
});
test('mismatched session and reused call cannot join snapshot',()=>{
  for (const [patch,code] of [[{sessionId:'different'},'ATK_PROJECTION_BINDING'],[{callId:'instrument'},'ATK_SNAPSHOT_DUPLICATE_CALL']]) {
    const input=fixture();input.histories.openOrders=[record('open','spot_get_orders','trade/orders-pending',{status:'open',limit:2},[],nowMs,patch)];
    assert.equal(assembleDemoAccountSnapshot(input).code,code);
  }
});
test('unfinished history and extra pages after terminal cannot become complete',()=>{
  const input=fixture();
  input.histories.openOrders=[record('open','spot_get_orders','trade/orders-pending',{status:'open',limit:2},[
    {ordId:'10',instId:'AVAX-USDT',instType:'SPOT',state:'live'}])];
  assert.equal(assembleDemoAccountSnapshot(input).code,'ATK_SNAPSHOT_HISTORY_UNFINISHED');
  const extra=fixture();extra.histories.fills.push(extra.histories.fills[0]);
  assert.equal(assembleDemoAccountSnapshot(extra).code,'ATK_SNAPSHOT_EXTRA_PAGE');
});
test('forged completion, accessors and modified payload are rejected',()=>{
  assert.equal(assembleDemoAccountSnapshot({...fixture(),ready:true}).ok,false);
  const input=fixture();input.histories.fills={scanExhausted:true,rows:[]};
  assert.equal(assembleDemoAccountSnapshot(input).ok,false);
  let reads=0;const accessor=fixture();Object.defineProperty(accessor,'tickerRecord',{get(){reads++;throw new Error();}});
  assert.equal(assembleDemoAccountSnapshot(accessor).ok,false);assert.equal(reads,0);
  const fake=fixture();fake.feeRecord=JSON.parse(JSON.stringify(fake.feeRecord));fake.feeRecord.payload.structuredContent.data.data[0].feeGroup[0].taker='0';
  assert.equal(assembleDemoAccountSnapshot(fake).code,'ATK_SNAPSHOT_RECORD');
});

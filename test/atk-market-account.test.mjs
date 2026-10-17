// Acceptance sources only. Not executed; no SDK, transport or live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {openATKObservation,normalizeDemoInstrument,normalizeDemoTicker,normalizeDemoBalance,normalizeDemoFeeRates} from '../src/adapters/atk-market-account.mjs';
import {compareDemoAccountIdentity} from '../src/adapters/atk-market-account.mjs';
import {copyAccountExpectation} from '../src/adapters/atk-account-expectation.mjs';

const nowMs=1770000000000;
const expectedBinding={connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),sessionId:'session-1',accountId:'demo-alias'};
const options={expectedBinding,nowMs,maxAgeMs:10000,maxSkewMs:100};
const accountExpectation={schemaVersion:1,connectionHash:expectedBinding.connectionHash,accountId:expectedBinding.accountId,expectedUid:'123'};
function record(tool,args,rows,{at=nowMs,otherRows=rows}={}) {
  const paths={market_get_instruments:'public/instruments',market_get_ticker:'market/ticker',account_get_config:'account/config',account_get_balance:'account/balance',account_get_trade_fee:'account/trade-fee'};
  const envelope={tool,ok:true,data:{endpoint:'GET /api/v5/'+paths[tool],requestTime:new Date(at).toISOString(),data:rows},
    capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{[tool.split('_')[0]]:{status:'enabled'}}},timestamp:new Date(at).toISOString()};
  const second={...envelope,data:{...envelope.data,data:otherRows}};
  const result=prepareATKObservation({schemaVersion:1,...expectedBinding,observationId:'obs-'+tool,callId:'call-'+tool,
    taskId:null,intentId:null,tool,args,requestedAtMs:at,receivedAtMs:at},
    {structuredContent:envelope,content:[{type:'text',text:JSON.stringify(second)}],isError:false});
  assert.equal(result.ok,true);return result.record;
}
const instrument=(patch={})=>({instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',ruleType:'normal',
  groupId:'1',upcChg:[],tickSz:'0.010000000',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000',maxLmtAmt:'100000',...patch});
const instrumentRecord=(patch={},settings={})=>record('market_get_instruments',{instType:'SPOT',instId:'AVAX-USDT',demo:true},[instrument(patch)],settings);
const asset=(ccy,patch={})=>({ccy,uTime:String(nowMs-100000),eq:'10',cashBal:'10',availBal:'10',frozenBal:'0',ordFrozen:'0',
  liab:'0',crossLiab:'0',interest:'0',borrowFroz:'0',fixedBal:'0',stgyEq:'0',spotIsoBal:'0',smtSyncEq:'0',spotCopyTradingEq:'0',...patch});
const balance=(details=[asset('AVAX'),asset('USDT')])=>record('account_get_balance',{},[
  {uTime:String(nowMs-100000),imr:'0',mmr:'0',borrowFroz:'0',notionalUsd:'0',details}]);
const configuration=(at=nowMs)=>record('account_get_config',{},[{acctLv:'1',enableSpotBorrow:false,autoLoan:false,spotBorrowAutoRepay:false,feeType:'0',uid:'123'}],{at});
function disabled(result) {
  for (const key of ['launchAllowed','readAuthorized','writeEnabled','routeVerified','actualAccountVerified']) assert.equal(result[key],false,key);
}

test('independent account UID comparison rejects mismatches, stale records and different connections',()=>{
  const check=patch=>compareDemoAccountIdentity(configuration(),{...options,accountExpectation,...patch});
  const matched=check({});assert.equal(matched.ok,true);disabled(matched);
  assert.equal(matched.uidMatchesExpectation,true);
  assert.equal(JSON.stringify(matched).includes('"expectedUid"'),false);
  assert.equal(check({accountExpectation:{...accountExpectation,expectedUid:'456'}}).code,'ATK_ACCOUNT_UID_MISMATCH');
  assert.equal(check({accountExpectation:{...accountExpectation,expectedUid:123}}).code,'ATK_ACCOUNT_EXPECTATION');
  assert.equal(check({accountExpectation:{...accountExpectation,connectionHash:'d'.repeat(64)}}).code,'ATK_ACCOUNT_EXPECTATION');
  assert.equal(check({nowMs:nowMs+10001}).code,'ATK_PROJECTION_STALE');
  assert.equal(check({accountExpectation:null}).code,'ATK_ACCOUNT_EXPECTATION');
  const accessor={...accountExpectation};Object.defineProperty(accessor,'expectedUid',{get(){throw new Error('must not execute');}});
  assert.throws(()=>copyAccountExpectation(accessor,expectedBinding.connectionHash,expectedBinding.accountId),/ATK_ACCOUNT_EXPECTATION/);
});
test('instrument decimals remain exact and upcoming changes block',()=>{
  const valid=normalizeDemoInstrument(instrumentRecord(),options);
  assert.equal(valid.ok,true);assert.equal(valid.instrument.tickSz,'0.01');disabled(valid);
  assert.equal(valid.usdNotionalLimitRequiresIndependentCheck,true);
  assert.equal(normalizeDemoInstrument(instrumentRecord({upcChg:[{param:'tickSz',newValue:'1',effTime:String(nowMs+1000)}]}),options).code,'ATK_PROJECTION_TRANSITION');
  assert.equal(normalizeDemoInstrument(instrumentRecord({tickSz:'0.000000001'}),options).code,'ATK_PROJECTION_DECIMAL');
});
test('all payload copies must agree; a declared binding never grants authority',()=>{
  const value=instrumentRecord({}, {otherRows:[instrument({tickSz:'1'})]});
  assert.equal(openATKObservation(value,{expectedTool:'market_get_instruments',expectedBinding}).code,'ATK_PROJECTION_CONFLICT');
  const wrong=openATKObservation(instrumentRecord(),{expectedTool:'market_get_instruments',expectedBinding:{...expectedBinding,sessionId:'different'}});
  assert.equal(wrong.code,'ATK_PROJECTION_BINDING');disabled(wrong);
});
test('ticker checks exchange timestamp, not wrapper requestTime',()=>{
  const ticker=ts=>record('market_get_ticker',{instId:'AVAX-USDT',demo:true},[{instId:'AVAX-USDT',instType:'SPOT',askPx:'10',askSz:'2',ts:String(ts)}]);
  assert.equal(normalizeDemoTicker(ticker(nowMs),options).ok,true);
  assert.equal(normalizeDemoTicker(ticker(nowMs-10001),options).code,'ATK_PROJECTION_STALE');
  assert.equal(normalizeDemoTicker(ticker(nowMs+101),options).code,'ATK_PROJECTION_FUTURE');
});
test('cash policy preserves idle balances but rejects missing debt, third assets and asynchronous config',()=>{
  const opts={...options,accountConfigRecord:configuration()};
  const valid=normalizeDemoBalance(balance(),opts);assert.equal(valid.ok,true);disabled(valid);
  const missing=asset('AVAX');delete missing.liab;
  assert.equal(normalizeDemoBalance(balance([missing,asset('USDT')]),opts).ok,false);
  assert.equal(normalizeDemoBalance(balance([asset('AVAX',{liab:''}),asset('USDT')]),opts).ok,false);
  assert.equal(normalizeDemoBalance(balance([asset('AVAX'),asset('USDT'),asset('BTC')]),opts).code,'ATK_PROJECTION_BALANCE_ASSET');
  assert.equal(normalizeDemoBalance(balance(),{...options,accountConfigRecord:configuration(nowMs-101)}).code,'ATK_PROJECTION_CLOCK');
});
test('fees require matching group; rebates cannot reduce budget; inter-observation skew blocks',()=>{
  const fee=rows=>record('account_get_trade_fee',{instType:'SPOT',instId:'AVAX-USDT'},rows);
  const rows=[{instType:'SPOT',ts:String(nowMs),feeGroup:[{groupId:'1',maker:'0.001',taker:'-0.002'}]}];
  const valid=normalizeDemoFeeRates(fee(rows),{...options,instrumentRecord:instrumentRecord()});
  assert.equal(valid.ok,true);assert.equal(valid.fees.quoteFeeRateMax,'0.002');assert.equal(valid.fees.feeCurrencyResolved,false);disabled(valid);
  assert.equal(normalizeDemoFeeRates(fee([{instType:'SPOT',ts:String(nowMs),maker:'-0.001',taker:'-0.002'}]),{...options,instrumentRecord:instrumentRecord()}).code,'ATK_PROJECTION_FEE_GROUP');
  assert.equal(normalizeDemoFeeRates(fee(rows),{...options,instrumentRecord:instrumentRecord({}, {at:nowMs-101})}).code,'ATK_PROJECTION_CLOCK');
});

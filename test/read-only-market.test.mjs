import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {ReadOnlyMarketService} from '../src/read-only-market.mjs';

const binding={sessionId:'market-session',accountId:'demo-account',connectionHash:'a'.repeat(64),
  catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64)};

function fixture(t,{now=1700000000000,clock=()=>now,source='registered',exchangeTime=now,row={}}={}) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-market-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const capture=store.openATKCaptureSession(binding);let calls=0;
  const client={journalContext:()=>binding,callJournalledRead:async(tool,args)=>{
    calls++;const current=clock(),at=new Date(current).toISOString(),observationId='market-'+calls;
    const sourceTime=typeof exchangeTime==='function'?exchangeTime(calls,current):exchangeTime;
    const envelope={tool,ok:true,data:{endpoint:'GET /api/v5/market/ticker',requestTime:at,data:[{
      instId:'AVAX-USDT',instType:'SPOT',bidPx:'24.80',bidSz:'12',askPx:'24.82',askSz:'8',last:'24.81',
      ts:String(sourceTime),...row}]},capabilities:{readOnly:true,hasAuth:true,demo:true,
      moduleAvailability:{market:{status:'enabled'}}},timestamp:at};
    const prepared=prepareATKObservation({schemaVersion:1,...binding,taskId:null,intentId:null,
      observationId,callId:'call-'+calls,tool,args,requestedAtMs:current,receivedAtMs:current},
    {content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope,isError:false});
    assert.equal(prepared.ok,true);
    const receipt=source==='registered'?capture.capture(prepared.record):store.captureATKToolObservation(prepared.record);
    return receipt;
  }};
  return {store,client,calls:()=>calls,clock};
}

test('validated read-only ticker is consumed outside task economics and cached briefly',async t=>{
  const f=fixture(t),service=new ReadOnlyMarketService(f.store,f.client,{clock:f.clock,cooldownMs:5000});
  const result=await service.refresh();
  assert.deepEqual(result,{state:'LIVE_READ_ONLY',source:'OKX_TR_DEMO_ATK',instrument:'AVAX-USDT',
    bid:'24.8',ask:'24.82',last:'24.81',spread:'0.02',exchangeTimestampMs:f.clock(),observedAtMs:f.clock(),
    ageMs:0,freshness:'EXCHANGE_TIMESTAMP_CHECKED',cached:false,evidence:'JOURNALLED_AND_VALIDATED',
    orderSubmissionEnabled:false,executionMode:'fixture'});
  assert.equal(f.store.atkToolObservation('market-1').status,'APPLIED');
  assert.equal(f.store.hasUnappliedObservations(),false);assert.equal(f.store.list().length,0);
  assert.equal((await service.refresh()).cached,true);assert.equal(f.calls(),1);
});

test('stale market data is recorded as rejected informational evidence and never returned',async t=>{
  const f=fixture(t,{exchangeTime:1700000000000-20000}),service=new ReadOnlyMarketService(f.store,f.client,{clock:f.clock});
  await assert.rejects(service.refresh(),error=>error.status===409 && error.code==='READ_ONLY_MARKET_UNAVAILABLE');
  assert.equal(f.store.atkToolObservation('market-1').status,'APPLIED');
  assert.equal(f.store.hasUnappliedObservations(),false);assert.equal(f.store.list().length,0);
  const action=f.store.db.prepare('SELECT action FROM observation_review_actions').get();
  assert.equal(action.action,'READ_ONLY_MARKET_REJECTED');
});

test('unregistered market source cannot be consumed and remains a fail-closed blocker',async t=>{
  const f=fixture(t,{source:'supplied'}),service=new ReadOnlyMarketService(f.store,f.client,{clock:f.clock});
  await assert.rejects(service.refresh(),error=>error.status===409 && error.code==='READ_ONLY_MARKET_UNAVAILABLE');
  assert.equal(f.store.atkToolObservation('market-1').status,'PENDING');
  assert.equal(f.store.hasUnappliedObservations(),true);assert.equal(f.store.list().length,0);
});

test('failed refresh clears a previous success and cannot resurrect it during cooldown',async t=>{
  const base=1700000000000;let now=base;
  const f=fixture(t,{clock:()=>now,exchangeTime:(call,current)=>call===1?current:current-20000});
  const service=new ReadOnlyMarketService(f.store,f.client,{clock:f.clock,cooldownMs:5000});
  assert.equal((await service.refresh()).last,'24.81');
  now+=6000;
  await assert.rejects(service.refresh(),error=>error.status===409);
  now+=100;
  await assert.rejects(service.refresh(),error=>error.status===429);
  assert.equal(f.calls(),2);assert.equal(f.store.atkToolObservation('market-2').status,'APPLIED');
});

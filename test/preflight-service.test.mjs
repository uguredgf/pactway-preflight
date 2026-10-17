import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/persistence/store.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {PreflightRepository} from '../src/preflight/repository.mjs';
import {PreflightService} from '../src/preflight/service.mjs';
import {runReplayExample} from '../src/preflight/examples.mjs';

const ownerId='11111111-1111-4111-8111-111111111111';
const binding={sessionId:'preflight-session',accountId:'demo-account',connectionHash:'a'.repeat(64),
  catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64)};
const policyInput={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
  maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
const candidate={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.4'};
const wait=()=>new Promise(resolve=>setImmediate(resolve));

function setup(t,{connected=true,stale=false,endSessionAfterPlan=false,
    endSessionAfterReads=false,pauseReason=null,clock=()=>Date.now(),
    order=['market_get_instruments','market_get_ticker'],reviews=[{action:'ACCEPT',candidate:null,reasonCode:'WITHIN_LIMITS'}]}={}) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-preflight-service-')),store=new Store(directory);
  store.saveSession({tokenHash:'f'.repeat(64),ownerId,csrf:'e'.repeat(64),expiresAtMs:Date.now()+3600000});
  const repository=new PreflightRepository(store),capture=store.openATKCaptureSession(binding);
  const calls=[];let sequence=0;
  const client={journalContext:()=>binding,callJournalledRead:async(tool,args)=>{
    calls.push(tool);const now=Date.now(),at=new Date(now).toISOString(),observationId='preflight-'+(++sequence);
    const rows=tool==='market_get_ticker'
      ?[{instId:'AVAX-USDT',instType:'SPOT',askPx:'24.95',askSz:'4',ts:String(stale?now-20000:now)}]
      :[{instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',ruleType:'normal',
        groupId:'1',upcChg:[],tickSz:'0.01',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000',maxLmtAmt:'100000'}];
    const endpoint=tool==='market_get_ticker'?'GET /api/v5/market/ticker':'GET /api/v5/public/instruments';
    const envelope={tool,ok:true,data:{endpoint,requestTime:at,data:rows},capabilities:{readOnly:true,hasAuth:true,demo:true,
      moduleAvailability:{market:{status:'enabled'}}},timestamp:at};
    const prepared=prepareATKObservation({schemaVersion:1,...binding,taskId:null,intentId:null,observationId,
      callId:'call-'+sequence,tool,args,requestedAtMs:now,receivedAtMs:now},
    {content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope,isError:false});
    assert.equal(prepared.ok,true);const receipt=capture.capture(prepared.record);
    if(endSessionAfterReads && sequence===2)store.revokeSession('f'.repeat(64));
    return receipt;
  }};
  const planner={kind:'ollama',createPlan:async({checkId,ownerId:owner})=>{
    repository.reservePlanCall(owner,checkId);if(endSessionAfterPlan)store.revokeSession('f'.repeat(64));return {tools:[...order]};
  }};
  const agentReviewer={kind:'ollama',review:async({checkId,ownerId:owner,attempt})=>{
    repository.reserveAgentCall(owner,checkId);const result=reviews[attempt-1]??reviews.at(-1);
    if(result instanceof Error)throw result;return structuredClone(result);
  }};
  if(pauseReason)store.pauseGlobal(pauseReason);
  const service=new PreflightService({repository,getRuntime:()=>connected?{client,planner,agentReviewer,store}:null,clock});
  t.after(async()=>{await service.close();capture.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,repository,service,calls};
}
function approved(service) {
  const draft=service.createPolicy(ownerId,policyInput);
  return service.approvePolicy(ownerId,draft.id,{policyHash:draft.policyHash,acknowledgement:true});
}
async function completed(service,id) {
  for(let attempt=0;attempt<20;attempt++){
    const value=service.check(ownerId,id);if(value.state==='COMPLETED')return value;await wait();
  }
  throw new Error('check did not complete');
}

test('live preflight plans before exactly two fixed reads and consumes informational evidence atomically',async t=>{
  const f=setup(t),policy=approved(f.service),clientRequestId=randomUUID();
  const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'ALLOW');assert.deepEqual(f.calls,['market_get_instruments','market_get_ticker']);
  assert.deepEqual(done.report.agentTrace,{plannerKind:'ollama',plan:{tools:f.calls},modelCallCount:1,failureCode:null});
  assert.equal(f.store.hasUnappliedObservations(),false);assert.equal(f.store.list().length,0);
  const actions=f.store.db.prepare('SELECT action FROM observation_review_actions ORDER BY rowid').all().map(row=>row.action).sort();
  assert.deepEqual(actions,['PREFLIGHT_INSTRUMENT_ACCEPTED','PREFLIGHT_TICKER_ACCEPTED']);
  const replay=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId});
  assert.equal(replay.id,created.id);assert.equal(f.calls.length,2);
  assert.equal(f.store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,1);
  assert.throws(()=>f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,
    candidate:{...candidate,size:'0.5'},clientRequestId}),error=>error.status===409);
});

test('agent check makes the model action visible and accepts only after a fresh final governor read',async t=>{
  const f=setup(t),policy=approved(f.service),clientRequestId=randomUUID();
  const created=f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId});
  const done=await completed(f.service,created.id);
  assert.equal(done.source,'AGENT');assert.equal(done.report.verdict,'ALLOW');assert.equal(f.calls.length,4);
  assert.equal(done.report.agentTrace.version,1);assert.equal(done.report.agentTrace.modelCallCount,1);
  assert.deepEqual(done.report.agentTrace.attempts.map(item=>item.action),['ACCEPT']);
  assert.equal(done.report.agentTrace.attempts[0].reasonCode,'WITHIN_LIMITS');
  assert.equal(f.store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,1);
  const otherInput={policyId:policy.id,policyHash:policy.policyHash,candidate:{...candidate,size:'0.3'},
    clientRequestId:randomUUID(),source:'AGENT'};
  const other=f.repository.createCheck(ownerId,{...otherInput,policyRecord:f.repository.check(ownerId,created.id).policyRecord},
    {source:'AGENT',idempotencyInput:otherInput}).record;
  f.repository.markRunning(ownerId,other.id);f.repository.reserveAgentCall(ownerId,other.id);
  assert.throws(()=>f.repository.complete(ownerId,other.id,done.report),error=>error.code==='PREFLIGHT_REPORT_INVALID');
  assert.equal(f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId}).id,created.id);
  assert.throws(()=>f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId}),
    error=>error.code==='PREFLIGHT_IDEMPOTENCY_CONFLICT');
});

test('agent applies at most one downward revision and re-reads before both reevaluation and finalization',async t=>{
  const initial={...candidate,price:'24.999'};
  const f=setup(t,{reviews:[{action:'REVISE',candidate:{price:'24.99',size:'0.4'},reasonCode:'NORMALIZE_TO_RULES'},
    {action:'ACCEPT',candidate:null,reasonCode:'WITHIN_LIMITS'}]}),policy=approved(f.service);
  const created=f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate:initial,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'ALLOW');assert.equal(done.report.candidate.price,'24.99');assert.equal(f.calls.length,6);
  assert.deepEqual(done.report.agentTrace.attempts.map(item=>item.action),['REVISE','ACCEPT']);
  assert.equal(done.report.agentTrace.modelCallCount,2);
  assert.ok(done.report.agentTrace.attempts.every(item=>item.readFreshness.verified));
  const invalid=setup(t,{reviews:[{action:'REVISE',candidate:{price:'24.99',size:'0.4'},reasonCode:'NORMALIZE_TO_RULES'},
    {action:'REVISE',candidate:{price:'24.98',size:'0.4'},reasonCode:'NORMALIZE_TO_RULES'}]}),invalidPolicy=approved(invalid.service);
  const invalidDone=await completed(invalid.service,invalid.service.createAgentCheck(ownerId,{policyId:invalidPolicy.id,
    policyHash:invalidPolicy.policyHash,candidate:initial,clientRequestId:randomUUID()}).id);
  assert.equal(invalidDone.report.verdict,'INSUFFICIENT_DATA');assert.equal(invalidDone.report.agentTrace.modelCallCount,2);
  assert.equal(invalidDone.report.agentTrace.failureCode,'PREFLIGHT_AGENT_INVALID');
});

test('second reviewer failure after a real cap revision completes durably instead of storage uncertainty',async t=>{
  const secondFailure=Object.assign(new Error('invalid second response'),{code:'PREFLIGHT_AGENT_INVALID'});
  const f=setup(t,{reviews:[{action:'REVISE',candidate:{price:'25',size:'0.4'},reasonCode:'NORMALIZE_TO_RULES'},secondFailure]}),
    policy=approved(f.service),overCap={...candidate,price:'26.001'};
  const created=f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,
    candidate:overCap,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id),stored=f.repository.check(ownerId,created.id);
  assert.equal(done.state,'COMPLETED');assert.equal(done.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(done.report.agentTrace.failureCode,'PREFLIGHT_AGENT_INVALID');
  assert.equal(done.report.agentTrace.modelCallCount,2);assert.equal(stored.modelCallCount,2);
  assert.equal(f.store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,2);
});

test('first reviewer failure preserves a known cap BLOCK and completes durably',async t=>{
  const firstFailure=Object.assign(new Error('invalid first response'),{code:'PREFLIGHT_AGENT_INVALID'});
  const f=setup(t,{reviews:[firstFailure]}),policy=approved(f.service),overCap={...candidate,price:'26.001'};
  const created=f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,
    candidate:overCap,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id),stored=f.repository.check(ownerId,created.id);
  assert.equal(done.state,'COMPLETED');assert.equal(done.report.verdict,'BLOCK');
  assert.equal(done.report.reasonCodes.includes('PRICE_CAP_EXCEEDED'),true);
  assert.equal(done.report.agentTrace.failureCode,'PREFLIGHT_AGENT_INVALID');
  assert.equal(done.report.agentTrace.modelCallCount,1);assert.equal(stored.modelCallCount,1);
});

test('agent WAIT and reviewer errors remain fail closed',async t=>{
  const waiting=setup(t,{reviews:[{action:'WAIT',candidate:null,reasonCode:'NO_FEASIBLE_CANDIDATE'}]}),policy=approved(waiting.service);
  const tooSmall={...candidate,size:'0.05'};
  const waitDone=await completed(waiting.service,waiting.service.createAgentCheck(ownerId,{policyId:policy.id,
    policyHash:policy.policyHash,candidate:tooSmall,clientRequestId:randomUUID()}).id);
  assert.equal(waitDone.report.verdict,'BLOCK');assert.equal(waitDone.report.reasonCodes.includes('NO_FEASIBLE_CANDIDATE'),true);
  const unavailable=Object.assign(new Error('offline'),{code:'PREFLIGHT_AGENT_UNAVAILABLE'});
  const broken=setup(t,{reviews:[unavailable]}),brokenPolicy=approved(broken.service);
  const brokenDone=await completed(broken.service,broken.service.createAgentCheck(ownerId,{policyId:brokenPolicy.id,
    policyHash:brokenPolicy.policyHash,candidate,clientRequestId:randomUUID()}).id);
  assert.equal(brokenDone.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(brokenDone.report.agentTrace.failureCode,'PREFLIGHT_AGENT_UNAVAILABLE');
});

test('owner session ending after the model call prevents both ATK reads without refunding quota',async t=>{
  const f=setup(t,{endSessionAfterPlan:true}),policy=approved(f.service);
  const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'INSUFFICIENT_DATA');assert.equal(done.report.agentTrace.modelCallCount,1);
  assert.equal(done.report.agentTrace.failureCode,'PREFLIGHT_LIVE_UNAVAILABLE');assert.deepEqual(f.calls,[]);
  assert.equal(f.store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,1);
});

test('an exact idempotent retry returns the existing check after policy expiry without new work',async t=>{
  let now=Date.now();const f=setup(t,{clock:()=>now}),policy=approved(f.service),clientRequestId=randomUUID();
  const input={policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId};
  const created=f.service.createCheck(ownerId,input),done=await completed(f.service,created.id);
  now+=601000;
  const retry=f.service.createCheck(ownerId,input);
  assert.equal(retry.id,done.id);assert.equal(retry.state,'COMPLETED');assert.equal(f.calls.length,2);
  assert.throws(()=>f.service.createCheck(ownerId,{...input,candidate:{...candidate,size:'0.5'}}),
    error=>error.status===409 && error.code==='PREFLIGHT_IDEMPOTENCY_CONFLICT');
});

test('owner session ending during evidence reads prevents acceptance and closes both pages as rejected',async t=>{
  const f=setup(t,{endSessionAfterReads:true}),policy=approved(f.service);
  const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'INSUFFICIENT_DATA');assert.equal(done.report.agentTrace.failureCode,'PREFLIGHT_LIVE_UNAVAILABLE');
  assert.equal(f.calls.length,2);assert.equal(f.store.hasUnappliedObservations(),false);
  const actions=f.store.db.prepare('SELECT action FROM observation_review_actions ORDER BY rowid').all().map(row=>row.action).sort();
  assert.deepEqual(actions,['PREFLIGHT_INSTRUMENT_REJECTED','PREFLIGHT_TICKER_REJECTED']);
});

test('stale captured pages are closed as rejected evidence and produce insufficient data',async t=>{
  const f=setup(t,{stale:true}),policy=approved(f.service);
  const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'INSUFFICIENT_DATA');assert.equal(done.report.sanitizedEvidence,null);
  assert.equal(f.store.hasUnappliedObservations(),false);
  const actions=f.store.db.prepare('SELECT action FROM observation_review_actions ORDER BY rowid').all().map(row=>row.action).sort();
  assert.deepEqual(actions,['PREFLIGHT_INSTRUMENT_REJECTED','PREFLIGHT_TICKER_REJECTED']);
});

test('unavailable live runtime never falls back and restart completes pending work without calls',async t=>{
  const f=setup(t,{connected:false}),policy=approved(f.service);
  const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'INSUFFICIENT_DATA');assert.equal(done.report.agentTrace.plannerKind,'unavailable');
  assert.equal(done.report.agentTrace.modelCallCount,0);assert.deepEqual(f.calls,[]);

  const pending=f.repository.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,candidate,
    clientRequestId:randomUUID(),policyRecord:{id:policy.id,policy:policy.policy,policyHash:policy.policyHash,
      status:policy.status,createdAtMs:policy.createdAtMs,validFromMs:policy.validFromMs,expiresAtMs:policy.expiresAtMs}}).record;
  const recovered=new PreflightService({repository:f.repository,getRuntime:()=>{throw new Error('must not run');}});
  t.after(()=>recovered.close());
  const recoveredCheck=recovered.check(ownerId,pending.id);
  assert.equal(recoveredCheck.state,'COMPLETED');assert.equal(recoveredCheck.report.verdict,'INSUFFICIENT_DATA');
  assert.deepEqual(f.calls,[]);
});

test('existing pending evidence blocks planning and additional ATK captures',async t=>{
  const f=setup(t),now=Date.now();
  const pending=prepareATKObservation({schemaVersion:1,...binding,taskId:null,intentId:null,
    observationId:'unreviewed-existing',callId:'unreviewed-call',tool:'account_get_config',args:{},
    requestedAtMs:now,receivedAtMs:now},{content:[{type:'text',text:JSON.stringify({code:'0',data:[{uid:'demo'}]})}]});
  assert.equal(pending.ok,true);f.store.captureATKToolObservation(pending.record);
  const policy=approved(f.service),created=f.service.createCheck(ownerId,{policyId:policy.id,
    policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()});
  const done=await completed(f.service,created.id);
  assert.equal(done.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(done.report.agentTrace.failureCode,'PREFLIGHT_EVIDENCE_REJECTED');
  assert.equal(done.report.agentTrace.modelCallCount,0);assert.deepEqual(f.calls,[]);
  assert.equal(f.store.atkToolObservation('unreviewed-existing').status,'PENDING');
});

test('storage and operator safety pauses block live planning without clearing the pause',async t=>{
  for(const reason of ['OPERATOR_PAUSE','SAFETY_PROCESSING_FAILED','STORAGE_UNCERTAIN']) {
    const f=setup(t,{pauseReason:reason}),policy=approved(f.service);
    const created=f.service.createCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,
      candidate,clientRequestId:randomUUID()});
    const done=await completed(f.service,created.id);
    assert.equal(done.report.verdict,'INSUFFICIENT_DATA');assert.deepEqual(f.calls,[]);
    assert.equal(done.report.agentTrace.modelCallCount,0);assert.equal(f.store.globalSafetyStatus().reason,reason);
  }
});

test('a blocking durable pause remains a read-only fault across Store restart',t=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-preflight-pause-'));
  let store=new Store(directory);store.pauseGlobal('OPERATOR_PAUSE');store.close();store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(store.globalSafetyStatus().reason,'OPERATOR_PAUSE');
  assert.equal(store.readOnlySafetyStatus().allowed,false);
});

test('ambiguous preflight persistence failure latches read-only safety closed',t=>{
  const f=setup(t);
  f.store.db.exec("CREATE TRIGGER reject_preflight_policy BEFORE INSERT ON preflight_policies BEGIN SELECT RAISE(ABORT,'disk'); END");
  assert.throws(()=>f.service.createPolicy(ownerId,policyInput),{code:'PREFLIGHT_STORAGE_UNCERTAIN'});
  assert.equal(f.store.globalSafetyStatus().reason,'STORAGE_UNCERTAIN');
  assert.equal(f.store.readOnlySafetyStatus().allowed,false);
});

test('replay examples are deterministic completed records and never call live dependencies',t=>{
  const f=setup(t,{connected:false});
  const within=f.service.runExample(ownerId,'within-limits',{clientRequestId:randomUUID()});
  const breach=f.service.runExample(ownerId,'limit-breach',{clientRequestId:randomUUID()});
  const stale=f.service.runExample(ownerId,'stale-evidence',{clientRequestId:randomUUID()});
  assert.equal(within.report.verdict,'ALLOW');assert.equal(breach.report.verdict,'BLOCK');
  assert.equal(stale.report.verdict,'INSUFFICIENT_DATA');
  for(const item of [within,breach,stale])assert.equal(item.mode,'REPLAY');
  assert.deepEqual(f.calls,[]);
});

test('recovery snapshot preserves immutable preflight history and never restores browser authority',async t=>{
  const f=setup(t),policy=approved(f.service);
  const example=f.service.runExample(ownerId,'within-limits',{clientRequestId:randomUUID()});
  const agent=await completed(f.service,f.service.createAgentCheck(ownerId,{policyId:policy.id,policyHash:policy.policyHash,
    candidate,clientRequestId:randomUUID()}).id);
  f.store.pauseGlobal();const snapshot=f.store.exportRecoverySnapshot(Date.now());
  const targetDirectory=mkdtempSync(join(tmpdir(),'pactway-preflight-restore-')),restored=new Store(targetDirectory);
  t.after(()=>{restored.close();rmSync(targetDirectory,{recursive:true,force:true});});
  restored.restoreRecoverySnapshot(snapshot);
  const repository=new PreflightRepository(restored),history=repository.history(ownerId);
  assert.equal(history.policies[0].policyHash,policy.policyHash);
  assert.equal(history.checks.find(item=>item.id===example.id).report.verdict,'ALLOW');
  assert.equal(history.checks.find(item=>item.id===agent.id).source,'AGENT');
  assert.equal(history.checks.find(item=>item.id===agent.id).report.agentTrace.attempts[0].action,'ACCEPT');
  assert.equal(restored.activeSessionCount(Date.now()),0);
});

test('disk reopen completes interrupted live and replay checks without repeating model or ATK work',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-preflight-reopen-'));
  let store=new Store(directory),repository=new PreflightRepository(store),runtimeCalls=0;
  store.saveSession({tokenHash:'f'.repeat(64),ownerId,csrf:'e'.repeat(64),expiresAtMs:Date.now()+3600000});
  const original=new PreflightService({repository,getRuntime:()=>{runtimeCalls++;return null;}});
  const policy=approved(original),policyRecord=Object.fromEntries(
    ['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs'].map(key=>[key,policy[key]]));
  const liveInput={policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()};
  const live=repository.createCheck(ownerId,{...liveInput,policyRecord},{idempotencyInput:liveInput}).record;
  repository.markRunning(ownerId,live.id);repository.reservePlanCall(ownerId,live.id);
  const agentInput={policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID(),source:'AGENT'};
  const interruptedAgent=repository.createCheck(ownerId,{...agentInput,policyRecord},{source:'AGENT',idempotencyInput:agentInput}).record;
  repository.markRunning(ownerId,interruptedAgent.id);repository.reserveAgentCall(ownerId,interruptedAgent.id);
  const replayName='within-limits',replayInput={clientRequestId:randomUUID(),name:replayName};
  const replay=repository.createCheck(ownerId,replayInput,{mode:'REPLAY'}).record;
  repository.markRunning(ownerId,replay.id);
  store.pauseGlobal('OPERATOR_PAUSE');await original.close();store.close();

  store=new Store(directory);repository=new PreflightRepository(store);
  const recovered=new PreflightService({repository,getRuntime:()=>{runtimeCalls++;throw new Error('must not run');}});
  t.after(async()=>{await recovered.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const liveDone=recovered.check(ownerId,live.id),liveStored=repository.check(ownerId,live.id);
  assert.equal(liveDone.state,'COMPLETED');assert.equal(liveDone.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(liveDone.report.agentTrace.failureCode,'PREFLIGHT_PROCESS_RESTARTED');
  assert.equal(liveStored.modelCallCount,1);
  const agentDone=recovered.check(ownerId,interruptedAgent.id),agentStored=repository.check(ownerId,interruptedAgent.id);
  assert.equal(agentDone.state,'COMPLETED');assert.equal(agentDone.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(agentDone.report.agentTrace.failureCode,'PREFLIGHT_PROCESS_RESTARTED');assert.equal(agentStored.modelCallCount,1);
  assert.equal(store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,2);
  const replayDone=recovered.check(ownerId,replay.id);
  assert.equal(replayDone.state,'COMPLETED');assert.deepEqual(replayDone.report,runReplayExample(replayName));
  assert.equal(runtimeCalls,0);assert.equal(store.globalSafetyStatus().reason,'OPERATOR_PAUSE');
  assert.equal(store.readOnlySafetyStatus().allowed,false);
  assert.throws(()=>recovered.check(randomUUID(),live.id),error=>error.status===404 && error.code==='PREFLIGHT_CHECK_NOT_FOUND');
});

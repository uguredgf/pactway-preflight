// Acceptance sources only; not run. No SDK, HTTP, model or exchange execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hashCanonical,hashPolicy} from '../src/domain/governor.mjs';
import {createLedger,prepareIntent,markSubmitting} from '../src/domain/ledger.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {prepareDemoWireBody} from '../src/adapters/prepared-wire-body.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {correlateDemoOrder} from '../src/adapters/demo-order-correlation.mjs';
import {previewDemoLifecycle} from '../src/domain/demo-lifecycle.mjs';
import {planDemoSafety} from '../src/domain/demo-safety.mjs';
import {assessDemoSettlement} from '../src/domain/demo-settlement.mjs';
import {DemoSafetyDispatcher} from '../src/adapters/demo-safety-dispatcher.mjs';
import {createSingleDelivery} from '../src/adapters/single-delivery.mjs';
import {Store} from '../src/persistence/store.mjs';
import {createTaskId} from '../src/audit/commitments.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture() {
  const manifest=createDemoConnectionManifest({schemaVersion:1,id:'connection',connectionVersion:'v1',accountId:'account',
    environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
  const policy={id:'policy',taskId:'task',accountId:'account',environment:'demo',executionMode:'demo-prepared',
    instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',budget:'100',singleOrderNotionalMax:'25',
    maxPrice:'25',maxShare:'0.5',quoteFeeRateMax:'0.002',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0.002',
    approvedAtMs:1000,expiresAtMs:11000,orderLifetimeMs:5000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:100,
    campaignId:'campaign',campaignVersion:1,campaignHash:'a'.repeat(64),connectionVersion:'v1'};
  const approvedPolicyHash=hashPolicy(policy),payload={instId:'AVAX-USDT',tdMode:'cash',side:'buy',ordType:'limit',px:'10',sz:'2'};
  let ledger=prepareIntent(createLedger({taskId:'task',accountId:'account',budget:'100'}),
    {id:'intent',clOrdId:'Pactway001',createdAtMs:1100,decision:{ok:true,code:'ACCEPTED',payload,
      payloadHash:hashCanonical(payload),reserve:'20.05',evidence:{policyHash:approvedPolicyHash,snapshotHash:'b'.repeat(64)}}});
  const prepared=prepareDemoWireBody({manifest,policy,approvedPolicyHash,intent:ledger.intents[0],nowMs:1200});
  ledger=markSubmitting(ledger,'intent');
  const task={id:'task',mode:'demo-prepared',policy,approvedPolicyHash,ledger,
    submission:{intentId:'intent',committedAtMs:1200,prepared}};
  const expectedBinding={connectionHash:manifest.configHash,catalogHash:'c'.repeat(64),isolatedEntrySha256:'d'.repeat(64),
    accountId:'account',sessionId:'session'};
  return {task,expectedBinding,nowMs:2000};
}
function record(f,tool,args,rows,{id='query',at=1300,context={}}={}) {
  const write=['spot_place_order','spot_cancel_order'].includes(tool);
  const endpoint=tool==='spot_cancel_order'?'POST /api/v5/trade/cancel-order':tool==='spot_place_order'?'POST /api/v5/trade/order':
    tool==='spot_get_fills'?'GET /api/v5/trade/fills':'GET /api/v5/trade/order';
  const envelope={tool,ok:true,data:{endpoint,requestTime:new Date(at).toISOString(),data:rows},
    capabilities:{readOnly:!write,hasAuth:true,demo:true,moduleAvailability:{spot:{status:'enabled'}}},timestamp:new Date(at).toISOString()};
  const prepared=prepareATKObservation({schemaVersion:1,...f.expectedBinding,observationId:id,callId:'call-'+id,
    taskId:'task',intentId:'intent',tool,args,requestedAtMs:at,receivedAtMs:at,...context},
    {structuredContent:envelope,isError:false});
  assert.equal(prepared.ok,true);return prepared.record;
}
const order=(patch={})=>({ordId:'987',clOrdId:'Pactway001',instType:'SPOT',instId:'AVAX-USDT',tdMode:'cash',side:'buy',
  ordType:'limit',px:'10',sz:'2',accFillSz:'2',state:'filled',...patch});
function query(f,rows=[order()]) {
  const intent=f.task.ledger.intents[0];
  return record(f,'spot_get_order',{instId:'AVAX-USDT',clOrdId:intent.clOrdId,...(intent.ordId?{ordId:intent.ordId}:{})},rows);
}
const fill=(patch={})=>({billId:'100',tradeId:'50',ordId:'987',clOrdId:'Pactway001',instType:'SPOT',instId:'AVAX-USDT',
  side:'buy',fillPx:'10',fillSz:'2',fee:'-0.04',feeCcy:'USDT',...patch});
function pages(f,rows=[fill()]) {
  const args={archive:false,instId:'AVAX-USDT',ordId:'987',begin:'1100',end:'2000',limit:100};
  return [record(f,'spot_get_fills',args,rows,{id:'fills',at:1400}),
    record(f,'spot_get_fills',{...args,after:rows.at(-1).billId},[],{id:'empty',at:1500})];
}
test('lost ACK binds only through exact original-client query and matching economics',()=>{
  const f=fixture(),good=correlateDemoOrder({...f,record:query(f)});
  assert.equal(good.ok,true);assert.equal(good.normalized.ordId,'987');assert.equal(good.settlementAuthorized,false);
  for(const patch of [{clOrdId:'someoneElse'},{px:'11'},{sz:'3'},{side:'sell'}])
    assert.equal(correlateDemoOrder({...f,record:query(f,[order(patch)])}).ok,false);
  assert.equal(correlateDemoOrder({...f,record:query(f,[])}).code,'CORRELATION_UNRESOLVED');
  assert.equal(correlateDemoOrder({...f,record:query(f),expectedBinding:{...f.expectedBinding,sessionId:'other'}}).ok,false);
});
test('place and cancel ACKs never synthesize a fill or settlement',()=>{
  const f=fixture(),{tag,...args}=f.task.submission.prepared.body;
  const ack=record(f,'spot_place_order',args,[{sCode:'0',clOrdId:'Pactway001',ordId:'987'}]);
  const preview=previewDemoLifecycle({...f,record:ack});
  assert.equal(preview.ok,true);assert.equal(preview.candidateLedger.intents[0].state,'SUBMITTING');
  assert.equal(preview.candidateLedger.intents[0].fills.length,0);assert.equal(preview.summary.reserved,'20.05');
  assert.equal(previewDemoLifecycle({...f,record:record(f,'spot_place_order',args,[{sCode:'500',clOrdId:'Pactway001',ordId:'987'}])}).ok,false);
  f.task.ledger=preview.candidateLedger;
  const cancel=record(f,'spot_cancel_order',{instId:'AVAX-USDT',clOrdId:'Pactway001',ordId:'987'},[{sCode:'0',ordId:'987'}]);
  const stopped=previewDemoLifecycle({...f,record:cancel});
  assert.equal(stopped.candidateLedger.intents[0].state,'CANCEL_PENDING');assert.equal(stopped.summary.reserved,'20.05');
});
test('terminal quantity and complete arithmetic still cannot release without provenance/coverage',()=>{
  const f=fixture(),preview=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f)});
  assert.equal(preview.ok,true);assert.equal(preview.arithmeticReady,true);
  assert.equal(preview.summary.spent,'20.04');assert.equal(preview.summary.reserved,'0.01');
  assert.equal(preview.candidateLedger.intents[0].settled,false);assert.equal(preview.applied,false);
  assert.equal(f.task.ledger.intents[0].ordId,null);
});
test('missing fee enrichment is idempotent; conflicting fee preserves prior known costs',()=>{
  const f=fixture();
  const missing=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f,[fill({fee:''})])});
  assert.equal(missing.arithmeticReady,false);assert.equal(missing.summary.spent,'20');
  f.task.ledger=missing.candidateLedger;
  const enriched=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f)});
  assert.equal(enriched.summary.spent,'20.04');f.task.ledger=enriched.candidateLedger;
  assert.equal(previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f)}).summary.spent,'20.04');
  const conflict=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f,[fill({fee:'-0.05'})])});
  assert.equal(conflict.requiresReview,true);assert.equal(conflict.summary.spent,'20.04');
});
test('cost over reserve is preserved; unsupported fees and truncated scans cannot settle',()=>{
  const f=fixture();
  const excess=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f,[fill({fillPx:'11'})])});
  assert.equal(excess.summary.spent,'22.04');assert.equal(excess.requiresReview,true);assert.equal(excess.arithmeticReady,false);
  assert.equal(previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f,[fill({feeCcy:'BTC'})])}).requiresReview,true);
  assert.equal(previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f).slice(0,1)}).arithmeticReady,false);
});
test('stop/expiry/session loss query UNKNOWN and cancel known open orders without reversing fills',()=>{
  const f=fixture();let intent=f.task.ledger.intents[0];
  for(const patch of [{globalPaused:true},{campaignPaused:true},{ownerActive:false},{nowMs:6100}]) {
    intent.state='UNKNOWN';
    const plan=planDemoSafety({...f,intent,globalPaused:false,campaignPaused:false,ownerActive:true,...patch});
    assert.equal(plan.stopRequired,true);assert.equal(plan.action,'QUERY');assert.equal(plan.resubmitAllowed,false);
    assert.equal(plan.releaseReserve,false);assert.equal(plan.reverseTrade,false);
  }
  intent={...intent,state:'PARTIAL',ordId:'987'};
  assert.equal(planDemoSafety({...f,intent,globalPaused:true,campaignPaused:false,ownerActive:true}).action,'CANCEL_THEN_QUERY');
  intent={...intent,settled:true};
  assert.equal(planDemoSafety({...f,intent,globalPaused:true,campaignPaused:false,ownerActive:true}).action,'NONE');
});
test('delivery response is journalled before recovery; capture failure pauses without resend',async()=>{
  for(const captureFails of [false,true]) {
    const events=[];
    const deliver=createSingleDelivery({clock:()=>1200,transport:()=>{events.push('send');return {};},store:{
      commitDemoSubmission:()=>{events.push('commit');return {checkedAtMs:1200,validUntilMs:1300};},
      captureDemoDeliveryResponse:()=>{events.push('capture');if(captureFails)throw new Error();return {observationId:'ack'};},
      markDemoSubmissionUnknown:()=>events.push('unknown'),pauseGlobal:()=>events.push('pause')}});
    const result=await deliver({});assert.equal(result.retryAllowed,false);
    assert.deepEqual(events,captureFails?['commit','send','capture','pause','unknown']:['commit','send','capture','unknown']);
  }
});

test('persisted review binds every source/status; closed consume gate leaves all economic state untouched',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-consume-')),store=new Store(directory);
  try {
    const f=fixture();
    // Test-only persisted future-attempt seed. This does not open the application's
    // submission gate or assert the positive production commit path works.
    const {submission,...initial}=f.task;
    const saved=store.create({...initial,auditTaskId:createTaskId('task'),ownerId:'owner',busy:false,attempts:0,
      ledger:createLedger({taskId:'task',accountId:'account',budget:'100',phase:'WAITING'})});
    saved.ledger=f.task.ledger;saved.submission=submission;saved.attempts=1;
    store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(JSON.stringify(saved),'task');
    const orderRecord=query(f),fillRecords=pages(f);
    for(const record of [orderRecord,...fillRecords])store.captureATKToolObservation(record);
    const input={observationId:'query',fillObservationIds:['fills','empty'],expectedBinding:f.expectedBinding,nowMs:2000,pageSize:100};
    const review=store.previewDemoObservation('task',input);
    assert.equal(review.arithmeticReady,true);assert.equal(review.references.length,3);
    const before=store.get('task'),receiptCount=store.receipts('task').length;
    assert.throws(()=>store.consumeDemoObservation('task',{...input,expectedPreviewHash:review.previewHash}),
      {code:'LIFECYCLE_PROVENANCE_NOT_CONNECTED'});
    assert.deepEqual(store.get('task'),before);assert.equal(store.receipts('task').length,receiptCount);
    for(const id of ['query','fills','empty'])assert.equal(store.atkToolObservation(id).status,'PENDING');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM observation_replays WHERE kind='atk-consume'").get().n,0);
    assert.throws(()=>store.consumeDemoObservation('task',{...input,expectedPreviewHash:review.previewHash,complete:true}),
      {code:'LIFECYCLE_INPUT'});
    assert.throws(()=>store.previewDemoObservation('task',{...input,fillObservationIds:['query']}),{code:'LIFECYCLE_INPUT'});
    store.db.prepare("UPDATE atk_tool_observations SET status='QUARANTINED' WHERE observation_id='empty'").run();
    const changed=store.previewDemoObservation('task',input);
    assert.notEqual(changed.previewHash,review.previewHash);
    assert.throws(()=>store.consumeDemoObservation('task',{...input,expectedPreviewHash:review.previewHash}),{code:'LIFECYCLE_REVIEW_CHANGED'});
    assert.throws(()=>store.consumeDemoObservation('task',{...input,expectedPreviewHash:changed.previewHash}),{code:'LIFECYCLE_REPLAY_REQUIRED'});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('settlement candidate requires consumed unchanged economics and never authorizes itself',()=>{
  const f=fixture();f.task.revision=3;f.task.auditHead={sequence:'3',receiptHash:'a'.repeat(64)};
  const first=previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f)});
  f.task.ledger=first.candidateLedger;
  const review={...previewDemoLifecycle({...f,record:query(f),fillRecords:pages(f)}),
    taskRevision:3,auditHead:f.task.auditHead,references:[{id:'query',status:'APPLIED'},{id:'fills',status:'APPLIED'},{id:'empty',status:'APPLIED'}]};
  const candidate=assessDemoSettlement(f.task,review);
  assert.equal(candidate.ok,true);assert.equal(candidate.before.reserved,'0.01');assert.equal(candidate.after.reserved,'0');
  assert.equal(candidate.after.spent,'20.04');assert.equal(candidate.settlementAuthorized,false);
  assert.equal(f.task.ledger.intents[0].settled,false);
  assert.equal(assessDemoSettlement(f.task,{...review,taskRevision:2}).ok,false);
  assert.equal(assessDemoSettlement(f.task,{...review,references:[{status:'PENDING'}]}).ok,false);
  assert.equal(assessDemoSettlement(f.task,{...review,arithmeticReady:false}).ok,false);
  const changed=structuredClone(review);changed.candidateLedger.intents[0].fills[0].feeQuote='0.05';
  assert.equal(assessDemoSettlement(f.task,changed).code,'SETTLEMENT_LEDGER_CHANGED');
  f.task.ledger.stopRequested=true;f.task.ledger.phase='STOP_REQUESTED';
  const stopped={...review,candidateLedger:structuredClone(f.task.ledger)};
  assert.equal(assessDemoSettlement(f.task,stopped).candidateLedger.phase,'STOPPED');
});

test('safety dispatcher captures cancel then queries; pending evidence prevents another cancel',async()=>{
  const f=fixture();f.task.revision=1;f.task.ledger.intents[0].ordId='987';f.task.ledger.intents[0].state='OPEN';
  const sent=[],captured=[];let pending=false;
  const store={get:()=>f.task,verifySafetyTask:()=>true,globalSafetyStatus:()=>({paused:true}),ownerSessionActive:()=>false,
    recordDemoCancelAttempt:()=>{f.task.demoCancelAttempt={intentId:'intent'};},
    hasUnappliedObservations:()=>pending,pauseGlobal:()=>{},captureATKToolObservation:r=>{
      captured.push(r);pending=true;return {observationId:r.context.observationId};}};
  const transport=request=>{
    sent.push(request.tool);
    const rows=request.tool==='spot_cancel_order'?[{sCode:'0',ordId:'987',clOrdId:'Pactway001'}]:[order({state:'live',accFillSz:'0'})];
    const prepared=record(f,request.tool,request.args,rows);
    return {structuredContent:prepared.payload.structuredContent,isError:false};
  };
  let time=2000;
  const runner=new DemoSafetyDispatcher({store,transport,authorize:bound=>hashCanonical(bound),binding:f.expectedBinding,clock:()=>time});
  const result=await runner.run('task','intent');assert.equal(result.ok,true);
  assert.deepEqual(sent,['spot_cancel_order','spot_get_order']);assert.equal(captured.length,2);
  assert.equal((await runner.run('task','intent')).code,'SAFETY_DISPATCH_THROTTLED');
  time=5000;await runner.run('task','intent');assert.deepEqual(sent,['spot_cancel_order','spot_get_order','spot_get_order']);
  assert.equal(f.task.ledger.intents[0].state,'OPEN');assert.equal(f.task.ledger.intents[0].settled,false);
});

test('unverified safety authority cannot call transport, including under pause',async()=>{
  const f=fixture();f.task.revision=1;let calls=0,pauses=0;
  const runner=new DemoSafetyDispatcher({binding:f.expectedBinding,clock:()=>2000,authorize:()=>true,
    transport:()=>{calls++;},store:{get:()=>f.task,verifySafetyTask:()=>true,globalSafetyStatus:()=>({paused:true}),
      ownerSessionActive:()=>false,hasUnappliedObservations:()=>false,pauseGlobal:()=>pauses++}});
  const result=await runner.run('task','intent');assert.equal(result.ok,false);assert.equal(calls,0);assert.equal(pauses,1);
});

test('cancel attempt is durable and immutable without implying cancellation or releasing reserve',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-cancel-')),store=new Store(directory);
  try {
    const f=fixture(),{submission,...initial}=f.task;
    const saved=store.create({...initial,auditTaskId:createTaskId('task'),ownerId:'owner',busy:false,attempts:0,
      ledger:createLedger({taskId:'task',accountId:'account',budget:'100',phase:'WAITING'})});
    saved.ledger=f.task.ledger;saved.ledger.intents[0].state='OPEN';saved.ledger.intents[0].ordId='987';
    saved.submission=submission;saved.attempts=1;
    store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(JSON.stringify(saved),'task');
    // No active owner session: the local safety decision requires cancellation.
    const input={taskId:'task',intentId:'intent',taskRevision:saved.revision,binding:f.expectedBinding,atMs:2000,
      request:{tool:'spot_cancel_order',args:{instId:'AVAX-USDT',clOrdId:'Pactway001',ordId:'987'}}};
    const marked=store.recordDemoCancelAttempt(input);
    assert.equal(marked.ledger.intents[0].state,'CANCEL_PENDING');assert.equal(marked.ledger.intents[0].settled,false);
    assert.equal(marked.ledger.intents[0].initialReserve,'20.05');
    assert.equal(marked.demoCancelAttempt.requestHash,hashCanonical(input.request));
    assert.throws(()=>store.recordDemoCancelAttempt({...input,taskRevision:marked.revision}),{code:'SAFETY_CANCEL_CHANGED'});
    assert.throws(()=>store.update('task',state=>{delete state.demoCancelAttempt;}));
    assert.equal(store.get('task').demoCancelAttempt.requestHash,marked.demoCancelAttempt.requestHash);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

// Unexecuted source acceptance cases; supplied fixtures and synchronous in-memory sinks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareATKObservation,validateATKObservationRecord,ATKObservationJournal} from '../src/adapters/atk-observation-journal.mjs';

const context = (patch = {}) => ({schemaVersion:1,observationId:'observation-1',callId:'call-1',
  connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),
  sessionId:'session-1',accountId:'account-alias',taskId:'task-1',intentId:null,tool:'account_get_balance',
  args:{ccy:'USDT'},requestedAtMs:1000,receivedAtMs:1001,...patch});
const raw = () => ({content:[{type:'text',text:JSON.stringify({code:'0',data:[{ccy:'USDT',cashBal:'17.25',
  fee:'0.0004',unknownFinancialField:{key:'economic-key',amount:'0.50'}}]})}],isError:false});
const clone = value => JSON.parse(JSON.stringify(value));
const receipt = (record,duplicate = false) => ({observationId:record.context.observationId,payloadHash:record.payloadHash,status:'PENDING',duplicate});
function disabled(result) {
  for (const key of ['launchAllowed','readAuthorized','writeEnabled','routeVerified','actualAccountVerified']) assert.equal(result[key],false);
  assert.equal(Object.isFrozen(result),true);
}
function rejected(result,code) {disabled(result);assert.equal(result.ok,false);assert.equal(result.code,code);}

test('whole economic page is detached, immutable and context-bound; validator independently recomputes commitment',() => {
  const suppliedContext = context();const suppliedRaw = raw();const prepared = prepareATKObservation(suppliedContext,suppliedRaw);
  disabled(prepared);assert.equal(prepared.ok,true);assert.equal(prepared.record.projectable,true);
  const data = prepared.record.payload.content[0].data.data[0];
  assert.equal(data.cashBal,'17.25');assert.equal(data.fee,'0.0004');assert.equal(data.unknownFinancialField.key,'economic-key');
  suppliedContext.args.ccy = 'AVAX';suppliedRaw.content[0].text = '{}';
  assert.equal(prepared.record.context.args.ccy,'USDT');assert.equal(data.cashBal,'17.25');
  assert.equal(Object.isFrozen(data.unknownFinancialField),true);
  const valid = validateATKObservationRecord(prepared.record);assert.equal(valid.ok,true);assert.equal(valid.payloadHash,prepared.payloadHash);
  assert.equal(valid.record.projectable,true);assert.notEqual(valid.record,prepared.record);
  for (const patch of [{callId:'call-2'},{catalogHash:'d'.repeat(64)},{receivedAtMs:1002}])
    assert.notEqual(prepareATKObservation(context(patch),raw()).payloadHash,prepared.payloadHash);
  const tampered = clone(prepared.record);tampered.payload.content[0].data.data[0].cashBal = '999';
  rejected(validateATKObservationRecord(tampered),'ATK_OBSERVATION_HASH');
});

test('known credential/header names and free error text are redacted without financial row filtering',() => {
  const payload = {data:[{amount:'1.25',key:'financial-key',unknownFee:'0.001',
    api_key:'private-key',nested:{'OK-ACCESS-SIGN':'private-signature',response_headers:{secret:'private-header'}},
    msg:'private-error-message'}],message:'private-top-message',error:{code:'500',suggestion:'private-suggestion'}};
  const prepared = prepareATKObservation(context(),{structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]});
  assert.equal(prepared.ok,true);assert.equal(prepared.record.redacted,true);assert.equal(prepared.record.projectable,false);
  const encoded = JSON.stringify(prepared.record);
  for (const secret of ['private-key','private-signature','private-header','private-error-message','private-top-message','private-suggestion'])
    assert.equal(encoded.includes(secret),false);
  assert.equal(prepared.record.payload.structuredContent.data[0].unknownFee,'0.001');
  assert.equal(prepared.record.payload.structuredContent.data[0].key,'financial-key');
  const valid = validateATKObservationRecord(prepared.record);assert.equal(valid.ok,true);assert.equal(valid.payloadHash,prepared.payloadHash);
  const forged = clone(prepared.record);forged.projectable = true;forged.redacted = false;
  rejected(validateATKObservationRecord(forged),'ATK_OBSERVATION_RECORD');
  const secretArgs = prepareATKObservation(context({args:{instId:'AVAX-USDT',OKX_API_KEY:'private-arg'}}),raw());
  assert.equal(secretArgs.record.context.args.OKX_API_KEY,'[REDACTED]');assert.equal(secretArgs.record.projectable,false);
  assert.equal(validateATKObservationRecord(secretArgs.record).ok,true);
});

test('plain external text, unsupported blocks, tool errors and empty results cannot project',() => {
  for (const result of [
    {content:[{type:'text',text:'private-non-json-error'}]},
    {content:[{type:'image',data:'private-image',mimeType:'image/png'}]},
    {content:[],isError:true},
    {content:[]},
  ]) {
    const prepared = prepareATKObservation(context(),result);assert.equal(prepared.ok,true);assert.equal(prepared.record.projectable,false);
    assert.equal(JSON.stringify(prepared.record).includes('private-'),false);
    assert.equal(validateATKObservationRecord(prepared.record).ok,true);
  }
  const toolError = prepareATKObservation(context(),{structuredContent:{code:'500',data:[]},isError:true});
  assert.equal(toolError.ok,true);assert.equal(toolError.record.redacted,false);assert.equal(toolError.record.projectable,false);
  const fakeMarker = clone(prepareATKObservation(context(),raw()).record);
  fakeMarker.payload.content = [{type:'omitted',reason:'FAKE'}];
  rejected(validateATKObservationRecord(fakeMarker),'ATK_OBSERVATION_RECORD');
});

test('invalid context/own JSON/shape and oversized results fail closed without invoking getters',() => {
  for (const patch of [{tool:'spot_amend_order'},{receivedAtMs:999},{requestedAtMs:-1},
    {observationId:'with/path'},{catalogHash:'b'.repeat(64)+'\n'},{taskId:null,intentId:'intent'},
    {args:[]},{schemaVersion:2}]) rejected(prepareATKObservation(context(patch),raw()),'ATK_OBSERVATION_CONTEXT');
  let reads = 0;const getter = raw();Object.defineProperty(getter,'structuredContent',{enumerable:true,get(){reads++;return {};}});
  rejected(prepareATKObservation(context(),getter),'ATK_OBSERVATION_JSON');assert.equal(reads,0);
  const cyclic = {};cyclic.self = cyclic;
  rejected(prepareATKObservation(context(),{structuredContent:cyclic}),'ATK_OBSERVATION_JSON');
  for (const input of [{structuredContent:{bad:Infinity}},{content:new Array(2)},
    {structuredContent:Object.create({private:'secret'})}]) rejected(prepareATKObservation(context(),input),'ATK_OBSERVATION_JSON');
  rejected(prepareATKObservation(context(),{...raw(),_meta:{private:'secret'}}),'ATK_OBSERVATION_RESULT');
  rejected(prepareATKObservation(context({args:{padding:'x'.repeat(16384)}}),raw()),'ATK_OBSERVATION_LIMIT');
  rejected(prepareATKObservation(context(),{structuredContent:{padding:'x'.repeat(1024*1024)}}),'ATK_OBSERVATION_LIMIT');
  const deep = {};let level = deep;for (let i=0;i<25;i++) {level.next = {};level = level.next;}
  rejected(prepareATKObservation(context(),{structuredContent:deep}),'ATK_OBSERVATION_LIMIT');
  const hostile = new Proxy({}, {getPrototypeOf(){throw new Error('C:/private secret');}});
  const failed = prepareATKObservation(context(),hostile);rejected(failed,'ATK_OBSERVATION_JSON');
  assert.equal(JSON.stringify(failed).includes('private'),false);
});

test('sink precedes projection; callback receives only detached sanitized record; successful projection remains PENDING',() => {
  const phases = [];let durableRecord;
  const journal = new ATKObservationJournal({persist:record => {phases.push('persist');durableRecord = record;return receipt(record);}});
  const result = journal.captureAndProject(context(),raw(),(...args) => {
    phases.push('project');assert.equal(args.length,1);assert.equal(args[0],durableRecord);assert.equal(Object.isFrozen(args[0]),true);
    return {balance:args[0].payload.content[0].data.data[0].cashBal};
  });
  disabled(result);assert.equal(result.ok,true);assert.deepEqual(phases,['persist','project']);
  assert.equal(result.status,'PENDING');assert.equal(result.projected.balance,'17.25');assert.equal(journal.blocked,false);
});

test('write failure, invalid receipts and failed projection latch without automatic retry',() => {
  for (const persist of [() => {throw new Error('private-disk-error');},
    record => ({...receipt(record),payloadHash:'f'.repeat(64)}),
    record => ({...receipt(record),status:'APPLIED'}),record => ({...receipt(record),extra:'private'})]) {
    let writes = 0;let projects = 0;
    const journal = new ATKObservationJournal({persist:record => {writes++;return persist(record);}});
    const failed = journal.captureAndProject(context(),raw(),() => {projects++;return {};});
    assert.equal(failed.ok,false);assert.equal(journal.blocked,true);assert.equal(projects,0);
    assert.equal(failed.captureStatus,'UNKNOWN');assert.equal(failed.status,undefined);
    rejected(journal.captureAndProject(context(),raw(),() => {}),'ATK_OBSERVATION_JOURNAL_BLOCKED');assert.equal(writes,1);
    assert.equal(JSON.stringify(failed).includes('private'),false);
  }
  let stored;
  const failedProject = new ATKObservationJournal({persist:record => {stored = record;return receipt(record);}});
  const failure = failedProject.captureAndProject(context(),raw(),() => {throw new Error('private-projection');});
  rejected(failure,'ATK_OBSERVATION_PROJECTION_FAILED');assert.equal(failure.status,'PENDING');
  assert.equal(failure.captureStatus,'CAPTURED_PENDING');
  assert.equal(stored.context.observationId,'observation-1');assert.equal(failedProject.blocked,true);
});

test('capture status distinguishes no attempt, unknown sink outcome and acknowledged pending capture',() => {
  let attempts = 0;
  const invalid = new ATKObservationJournal({persist:record => {attempts++;return receipt(record);}});
  const notAttempted = invalid.captureAndProject(context({tool:'spot_amend_order'}),raw(),() => {});
  assert.equal(notAttempted.captureStatus,'NOT_ATTEMPTED');assert.equal(notAttempted.status,undefined);assert.equal(attempts,0);
  const committedThenThrown = [];
  const unknown = new ATKObservationJournal({persist:record => {committedThenThrown.push(record);throw new Error('reply lost after commit');}});
  const uncertain = unknown.captureAndProject(context(),raw(),() => {});
  assert.equal(committedThenThrown.length,1);assert.equal(uncertain.captureStatus,'UNKNOWN');assert.equal(uncertain.status,undefined);
  const acknowledged = new ATKObservationJournal({persist:receipt}).captureAndProject(context(),raw(),() => 'prepared');
  assert.equal(acknowledged.captureStatus,'CAPTURED_PENDING');assert.equal(acknowledged.status,'PENDING');
});

test('place and cancel acknowledgements can be journalled without granting transport authority',() => {
  for(const tool of ['spot_place_order','spot_cancel_order']) {
    let writes=0;
    const journal=new ATKObservationJournal({persist:record=>{writes++;return receipt(record);}});
    const acknowledgement={structuredContent:{data:[{sCode:'0',ordId:'123',clOrdId:'fixture-order'}]}};
    const result=journal.captureAndProject(context({tool,intentId:'intent-1',
      args:{instId:'AVAX-USDT',clOrdId:'fixture-order'}}),acknowledgement,record=>record.context.tool);
    disabled(result);assert.equal(result.ok,true);assert.equal(result.projected,tool);
    assert.equal(result.captureStatus,'CAPTURED_PENDING');assert.equal(result.status,'PENDING');
    assert.equal(writes,1);
  }
});

test('redacted/unprojectable result is captured before projection denial and remains pending',() => {
  let writes = 0;let projects = 0;
  const journal = new ATKObservationJournal({persist:record => {writes++;assert.equal(record.projectable,false);return receipt(record);}});
  const result = journal.captureAndProject(context(),{content:[{type:'text',text:'private-nonjson'}]},() => {projects++;});
  rejected(result,'ATK_OBSERVATION_PROJECTION_DENIED');assert.equal(writes,1);assert.equal(projects,0);
  assert.equal(result.status,'PENDING');assert.equal(journal.blocked,true);
});

test('exact duplicate skips projector; conflicting observation identity blocks rather than reapplying',() => {
  const rows = new Map();let projects = 0;
  const sink = record => {
    const previous = rows.get(record.context.observationId);
    if (previous && previous.payloadHash !== record.payloadHash) throw new Error('observation conflict');
    if (!previous) rows.set(record.context.observationId,record);
    return receipt(record,Boolean(previous));
  };
  const journal = new ATKObservationJournal({persist:sink});
  assert.equal(journal.captureAndProject(context(),raw(),() => ++projects).ok,true);
  const duplicate = journal.captureAndProject(context(),raw(),() => ++projects);
  assert.equal(duplicate.ok,true);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.projected,undefined);assert.equal(projects,1);
  const conflict = journal.captureAndProject(context(),{structuredContent:{balance:'18'}},() => ++projects);
  rejected(conflict,'ATK_OBSERVATION_PERSIST_FAILED');assert.equal(journal.blocked,true);assert.equal(projects,1);
  assert.equal(rows.size,1);
  // A new coordinator cannot infer past projection success from this PENDING receipt.
  const restarted = new ATKObservationJournal({persist:sink});
  assert.equal(restarted.captureAndProject(context(),raw(),() => ++projects).duplicate,true);assert.equal(projects,1);
});

test('declared async callbacks and returned thenables are rejected; reentrancy never projects',() => {
  assert.throws(() => new ATKObservationJournal({persist:async () => {}}),TypeError);
  let calls = 0;
  const asyncProject = new ATKObservationJournal({persist:receipt});
  rejected(asyncProject.captureAndProject(context(),raw(),async () => {calls++;}),'ATK_OBSERVATION_SYNC_REQUIRED');assert.equal(calls,0);
  const thenableSink = new ATKObservationJournal({persist:() => ({then(){calls++;}})});
  const unknownSink = thenableSink.captureAndProject(context(),raw(),() => {calls++;});
  rejected(unknownSink,'ATK_OBSERVATION_SYNC_REQUIRED');assert.equal(calls,0);
  assert.equal(unknownSink.captureStatus,'UNKNOWN');assert.equal(unknownSink.status,undefined);
  const thenableProject = new ATKObservationJournal({persist:receipt});
  rejected(thenableProject.captureAndProject(context(),raw(),() => ({get then(){calls++;return () => {};}})),
    'ATK_OBSERVATION_SYNC_REQUIRED');assert.equal(calls,0);
  let recursive;let projects = 0;
  recursive = new ATKObservationJournal({persist:record => {
    rejected(recursive.captureAndProject(context(),raw(),() => ++projects),'ATK_OBSERVATION_REENTRANT');return receipt(record);
  }});
  rejected(recursive.captureAndProject(context(),raw(),() => ++projects),'ATK_OBSERVATION_REENTRANT');assert.equal(projects,0);
});

// Receipt durability and restarted admission pause require independent Store/OS
// verification. The callback contract is trusted internal code, not a sandbox.

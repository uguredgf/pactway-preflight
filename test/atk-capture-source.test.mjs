// Source acceptance cases only. Not executed; no exchange or SDK connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {captureBinding} from '../src/persistence/atk-capture-binding.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {hashCanonical} from '../src/domain/governor.mjs';
import {decodeRecoverySnapshot} from '../src/persistence/recovery-format.mjs';

const binding={sessionId:'session-1',accountId:'account-1',connectionHash:'a'.repeat(64),
  catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64)};
function record(id='observation-1',patch={}) {
  const prepared=prepareATKObservation({schemaVersion:1,...binding,observationId:id,callId:'call-'+id,
    taskId:null,intentId:null,tool:'account_get_config',args:{},requestedAtMs:1000,receivedAtMs:1001,...patch},
  {content:[{type:'text',text:JSON.stringify({code:'0',data:[{uid:'123'}]})}]});
  assert.equal(prepared.ok,true);return prepared.record;
}
function setup() {
  const directory=mkdtempSync(join(tmpdir(),'pactway-source-'));
  return {directory,store:new Store(directory)};
}
function cleanup(env) {env.store.close();rmSync(env.directory,{recursive:true,force:true});}

test('supplied observations cannot acquire capture lineage through matching context or replay',()=>{
  const env=setup();
  try {
    const session=env.store.openATKCaptureSession(binding),supplied=record();
    env.store.captureATKToolObservation(supplied);
    assert.equal(env.store.atkObservationSource('observation-1').source,'SUPPLIED_RECORD');
    assert.throws(()=>session.capture(supplied),{code:'ATK_OBSERVATION_CONFLICT'});
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM atk_capture_receipts').get().n,0);
    session.capture(record('captured'));
    const source=env.store.atkObservationSource('captured');
    assert.equal(source.source,'REGISTERED_STDIO_CAPTURE');assert.equal(source.activeSession,true);
    assert.equal(source.writeEnabled,false);assert.equal(source.actualAccountVerified,false);assert.equal(source.routeVerified,false);
    assert.throws(()=>session.capture(record('wrong-account',{accountId:'other-account'})),{code:'ATK_CAPTURE_BINDING_MISMATCH'});
    assert.equal(env.store.atkToolObservation('wrong-account'),null);
    session.invalidate();assert.equal(env.store.atkObservationSource('captured').activeSession,false);
    session.capture(record('late'));assert.equal(env.store.atkObservationSource('late').activeSession,false);
    session.close();assert.throws(()=>session.capture(record('closed')),{code:'ATK_CAPTURE_SESSION_CLOSED'});
    assert.throws(()=>env.store.openATKCaptureSession(binding));
  } finally {cleanup(env);}
});

test('observation and capture receipt roll back together when receipt storage fails',()=>{
  const env=setup();
  try {
    const session=env.store.openATKCaptureSession(binding);
    env.store.db.exec("CREATE TRIGGER reject_capture BEFORE INSERT ON atk_capture_receipts BEGIN SELECT RAISE(ABORT,'disk'); END");
    assert.throws(()=>session.capture(record()),{code:'ATK_OBSERVATION_STORAGE_FAILED'});
    assert.equal(env.store.atkToolObservation('observation-1'),null);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM atk_capture_receipts').get().n,0);
  } finally {cleanup(env);}
});

test('restart and backup restore preserve lineage without restoring live session capability',()=>{
  const env=setup(),target=setup();
  try {
    const session=env.store.openATKCaptureSession(binding);session.capture(record());
    env.store.pauseGlobal();const backup=env.store.exportRecoverySnapshot(2000);
    assert.equal(decodeRecoverySnapshot(backup).schemaVersion,4);
    target.store.restoreRecoverySnapshot(backup);
    assert.equal(target.store.atkObservationSource('observation-1').source,'REGISTERED_STDIO_CAPTURE');
    assert.equal(target.store.atkObservationSource('observation-1').activeSession,false);
    assert.throws(()=>target.store.openATKCaptureSession(binding));
    assert.equal(target.store.globalSafetyStatus().reason,'RESTORE_RECONCILIATION_REQUIRED');
    env.store.close();env.store=new Store(env.directory);
    assert.equal(env.store.atkObservationSource('observation-1').activeSession,false);
    assert.throws(()=>session.capture(record('stale')),{code:'ATK_CAPTURE_SESSION_CLOSED'});
    assert.throws(()=>env.store.openATKCaptureSession(binding));
  } finally {cleanup(target);cleanup(env);}
});

test('legacy backups remain importable but cannot assert capture lineage',()=>{
  const env=setup(),target=setup();
  try {
    env.store.openATKCaptureSession(binding).capture(record());env.store.pauseGlobal();
    const {checksum,...body}=JSON.parse(env.store.exportRecoverySnapshot(2000));
    body.schemaVersion=1;delete body.tables.atk_capture_sessions;delete body.tables.atk_capture_receipts;
    delete body.tables.policy_workflows;delete body.tables.preflight_policies;delete body.tables.preflight_checks;
    const legacy=JSON.stringify({...body,checksum:hashCanonical(body)});
    target.store.restoreRecoverySnapshot(legacy);
    assert.equal(target.store.atkObservationSource('observation-1').source,'SUPPLIED_RECORD');
    assert.equal(target.store.atkObservationSource('observation-1').activeSession,false);
    body.tables.atk_capture_sessions=[];
    assert.throws(()=>decodeRecoverySnapshot(JSON.stringify({...body,checksum:hashCanonical(body)})),/RECOVERY_TABLES/);
  } finally {cleanup(target);cleanup(env);}
});

test('inconsistent receipt and session references reject restore even with a recomputed checksum',()=>{
  const env=setup();
  try {
    env.store.openATKCaptureSession(binding).capture(record());env.store.pauseGlobal();
    const backup=env.store.exportRecoverySnapshot(2000);
    for(const mutate of [
      tables=>{tables.atk_capture_receipts[0].payload_hash='f'.repeat(64);},
      tables=>{tables.atk_capture_receipts[0].observation_id='missing';},
      tables=>{tables.atk_capture_sessions=[];},
    ]) {
      const target=setup();
      try {
        const {checksum,...body}=JSON.parse(backup);mutate(body.tables);
        assert.throws(()=>target.store.restoreRecoverySnapshot(JSON.stringify({...body,checksum:hashCanonical(body)})));
        assert.equal(target.store.atkToolObservation('observation-1'),null);
        assert.equal(target.store.globalSafetyStatus().paused,true);
      } finally {cleanup(target);}
    }
  } finally {cleanup(env);}
});

test('binding registration rejects getters, extra keys and newline suffixes',()=>{
  let reads=0;const input={...binding};Object.defineProperty(input,'sessionId',{get(){reads++;return 'session-1';}});
  assert.throws(()=>captureBinding(input));assert.equal(reads,0);
  assert.throws(()=>captureBinding({...binding,extra:true}));
  for(const key of Object.keys(binding))assert.throws(()=>captureBinding({...binding,[key]:binding[key]+'\n'}));
});

test('read-only consumption enforces the server-owned tool arguments and leaves mismatches pending',()=>{
  const env=setup();
  try {
    const session=env.store.openATKCaptureSession(binding);
    for(const [id,args] of [['wrong-instrument',{instId:'BTC-USDT',demo:true}],['wrong-environment',{instId:'AVAX-USDT',demo:false}]]) {
      const saved=session.capture(record(id,{tool:'market_get_ticker',args}));
      assert.throws(()=>env.store.consumeReadOnlyEvidence({observationId:id,expectedBinding:binding,
        expectedTool:'market_get_ticker',expectedArgs:args,expectedPayloadHash:saved.payloadHash,
        action:'PREFLIGHT_TICKER_ACCEPTED'}),{code:'READONLY_EVIDENCE_INPUT'});
      assert.equal(env.store.atkToolObservation(id).status,'PENDING');
    }
    const valid=session.capture(record('valid-cleanup',{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}}));
    env.store.consumeReadOnlyEvidence({observationId:'valid-cleanup',expectedBinding:binding,
      expectedTool:'market_get_ticker',expectedArgs:{instId:'AVAX-USDT',demo:true},
      expectedPayloadHash:valid.payloadHash,action:'PREFLIGHT_TICKER_REJECTED'});
    assert.equal(env.store.atkToolObservation('valid-cleanup').status,'APPLIED');
    const accepted=session.capture(record('valid-accept',{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}}));
    assert.throws(()=>env.store.consumeReadOnlyEvidence({observationId:'valid-accept',expectedBinding:binding,
      expectedTool:'market_get_ticker',expectedArgs:{instId:'AVAX-USDT',demo:true},
      expectedPayloadHash:accepted.payloadHash,action:'PREFLIGHT_TICKER_ACCEPTED'}),{code:'READONLY_EVIDENCE_PENDING'});
    assert.equal(env.store.atkToolObservation('valid-accept').status,'PENDING');
  } finally {cleanup(env);}
});

// Acceptance SOURCE only: not executed during step 2.1. No SDK/network use.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {prepareATKObservation,ATKObservationJournal} from '../src/adapters/atk-observation-journal.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-atk-observation-'));
  let store=new Store(directory);
  t.after(()=>{
    try{store.close();}finally{
      const target=resolve(directory),parent=resolve(tmpdir());
      assert.equal(target.startsWith(parent+sep),true);
      assert.equal(basename(target).startsWith('pactway-atk-observation-'),true);
      rmSync(target,{recursive:true,force:true});
    }
  });
  return {get store(){return store;},reopen(){store.close();store=new Store(directory);return store;}};
}
function prepared({context={},price='24.80'}={}) {
  const result=prepareATKObservation({schemaVersion:1,observationId:'observation-1',callId:'call-1',
    connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),
    sessionId:'session-1',accountId:'demo-account',taskId:null,intentId:null,tool:'market_get_ticker',
    args:{instId:'AVAX-USDT',demo:true},requestedAtMs:1000,receivedAtMs:1100,...context},
    {content:[{type:'text',text:JSON.stringify({data:[{instId:'AVAX-USDT',last:price}]})}],isError:false});
  assert.equal(result.ok,true);return result.record;
}

test('account-wide result commits independently, remains pending and survives Store reopen',t=>{
  const f=fixture(t),record=prepared();
  assert.equal(f.store.hasUnappliedObservations(),false);
  const receipt=f.store.captureATKToolObservation(record);
  assert.deepEqual(receipt,{observationId:'observation-1',payloadHash:record.payloadHash,status:'PENDING',duplicate:false});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
  assert.equal(f.store.hasUnappliedObservations(),true);
  const reopened=f.reopen(),stored=reopened.atkToolObservation('observation-1');
  assert.equal(stored.status,'PENDING');
  assert.equal(stored.record.payloadHash,record.payloadHash);
  assert.equal(stored.record.context.taskId,null);
  assert.equal(Object.isFrozen(stored.record.payload),true);
  assert.equal(reopened.hasUnappliedObservations(),true);
});

test('Journal commits through the real Store before a failing projection; pending evidence survives restart',t=>{
  const f=fixture(t),record=prepared();
  const journal=new ATKObservationJournal({persist:entry=>f.store.captureATKToolObservation(entry)});
  const raw={content:[{type:'text',text:JSON.stringify({data:[{instId:'AVAX-USDT',last:'24.80'}]})}],isError:false};
  let projections=0,observedIndependentCommit=false;
  const failed=journal.captureAndProject(record.context,raw,()=>{
    projections++;
    assert.equal(f.store.atkToolObservation('observation-1').status,'PENDING');
    // Callback observes a completed independent commit, not an open capture transaction.
    f.store.db.exec('BEGIN IMMEDIATE');f.store.db.exec('ROLLBACK');
    observedIndependentCommit=true;
    throw new Error('private-projection-error');
  });
  assert.equal(failed.ok,false);assert.equal(failed.code,'ATK_OBSERVATION_PROJECTION_FAILED');
  assert.equal(observedIndependentCommit,true);
  assert.equal(failed.status,'PENDING');assert.equal(failed.captureStatus,'CAPTURED_PENDING');
  assert.equal(JSON.stringify(failed).includes('private-projection-error'),false);
  assert.equal(journal.blocked,true);assert.equal(f.store.hasUnappliedObservations(),true);
  assert.equal(journal.captureAndProject(record.context,raw,()=>{projections++;}).ok,false);
  assert.equal(projections,1);
  assert.equal(f.reopen().atkToolObservation('observation-1').status,'PENDING');
  assert.equal(f.store.hasUnappliedObservations(),true);
});

test('duplicate is explicit; changed evidence or another observation for the same call cannot overwrite it',t=>{
  const {store}=fixture(t),record=prepared();
  store.captureATKToolObservation(record);
  assert.equal(store.captureATKToolObservation(record).duplicate,true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM atk_tool_observations').get().n,1);
  assert.throws(()=>store.captureATKToolObservation(prepared({price:'25.00'})),{code:'ATK_OBSERVATION_CONFLICT'});
  assert.throws(()=>store.captureATKToolObservation(prepared({context:{observationId:'another-observation'}})),
    {code:'ATK_OBSERVATION_CONFLICT'});
  assert.equal(store.atkToolObservation('observation-1').record.payloadHash,record.payloadHash);
});

test('record forgery and corrupted stored evidence fail closed without automatic repair',t=>{
  const {store}=fixture(t),record=prepared();
  const forged=JSON.parse(JSON.stringify(record));forged.context.accountId='different-account';
  assert.throws(()=>store.captureATKToolObservation(forged),{code:'ATK_OBSERVATION_RECORD_INVALID'});
  store.captureATKToolObservation(record);
  store.db.prepare('UPDATE atk_tool_observations SET record=? WHERE observation_id=?')
    .run(JSON.stringify(forged),'observation-1');
  assert.throws(()=>store.captureATKToolObservation(record),{code:'ATK_OBSERVATION_STORAGE_FAILED'});
  assert.throws(()=>store.atkToolObservation('observation-1'),{code:'ATK_OBSERVATION_STORAGE_FAILED'});
  assert.equal(store.hasUnappliedObservations(),true);
});

test('storage failure rolls back, exposes a controlled code and never reports capture success',t=>{
  const {store}=fixture(t),record=prepared();
  store.db.exec(`CREATE TRIGGER reject_atk_observation BEFORE INSERT ON atk_tool_observations
    BEGIN SELECT RAISE(ABORT,'private-fixture-error'); END;`);
  assert.throws(()=>store.captureATKToolObservation(record),error=>{
    assert.equal(error.code,'ATK_OBSERVATION_STORAGE_FAILED');
    assert.equal(error.message.includes('private-fixture-error'),false);return true;
  });
  assert.equal(store.atkToolObservation('observation-1'),null);
  store.db.exec('DROP TRIGGER reject_atk_observation');
  assert.equal(store.captureATKToolObservation(record).duplicate,false);
});

test('capture cannot commit inside another transaction or treat a consumed row as a fresh projection',t=>{
  const {store}=fixture(t),record=prepared();
  store.db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>store.captureATKToolObservation(record),{code:'ATK_OBSERVATION_STORAGE_FAILED'});
  // Failed nested BEGIN must not roll back or commit the caller transaction.
  store.db.exec('ROLLBACK');
  store.captureATKToolObservation(record);
  // Test-only state mutation: no production mark-APPLIED method exists in this step.
  store.db.prepare("UPDATE atk_tool_observations SET status='QUARANTINED' WHERE observation_id=?").run('observation-1');
  assert.throws(()=>store.captureATKToolObservation(record),{code:'ATK_OBSERVATION_REPLAY_REQUIRED'});
  assert.equal(store.hasUnappliedObservations(),true);
});

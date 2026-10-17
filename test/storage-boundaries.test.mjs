// Local bounded SQLite allocation faults; no provider, exchange, or physical disk filling.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {RECOVERY_TABLES} from '../src/persistence/recovery-format.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';

const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
const config={id:'capacity-campaign',version:1,accountId:'fixture',connectionVersion:'test-v1',environment:'demo',instrument:'AVAX-USDT',budget:'1000',maxShare:'0.2'};
const binding={sessionId:'session-1',accountId:'account-1',connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64)};
function atkRecord(){
  const prepared=prepareATKObservation({schemaVersion:1,...binding,observationId:'observation-1',callId:'call-1',
    taskId:null,intentId:null,tool:'account_get_config',args:{},requestedAtMs:1000,receivedAtMs:1001},
  {content:[{type:'text',text:JSON.stringify({code:'0',data:[{uid:'123'}]})}]});
  assert.equal(prepared.ok,true);return prepared.record;
}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'pactway-storage-boundary-')),store=new Store(directory);
  t.after(()=>{
    store.close();const target=realpathSync(directory);
    assert.equal(dirname(target),realpathSync(tmpdir()));assert.ok(basename(target).startsWith('pactway-storage-boundary-'));
    rmSync(target,{recursive:true,force:true});
  });
  return {store,engine:new Engine(store,new FixturePlanner())};
}
function capture(store){return Object.fromEntries([...Object.keys(RECOVERY_TABLES),'visitor_sessions'].map(table=>
  [table,store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));}
function limit(store,trigger){
  store.db.exec('CREATE TABLE capacity_probe(payload BLOB); CREATE TEMP TRIGGER capacity_probe_insert '+trigger+' BEGIN INSERT INTO capacity_probe VALUES(zeroblob(1048576)); END;');
  const pages=store.db.prepare('PRAGMA page_count').get().page_count;
  assert.ok(Number.isSafeInteger(pages) && pages>0 && pages<4096);
  store.db.exec('PRAGMA max_page_count='+pages);
}
const cases=[
  ['draft creation','BEFORE INSERT ON model_workflows',f=>()=>f.engine.draft(fields)],
  ['draft editing','BEFORE UPDATE ON policy_workflows',f=>{
    const d=f.engine.draft(fields);return ()=>f.engine.drafts.edit('local-operator',d.id,{expectedRevision:d.revision,fields:{maxPrice:'24'}});
  }],
  ['workflow quota','BEFORE UPDATE ON model_call_budget',f=>{
    const d=f.engine.draft(fields);f.engine.approve({draftId:d.id,policyHash:d.policyHash,acknowledgement:true});
    return ()=>f.store.reserveOwnedModelCall(100,{workflowId:d.id,ownerId:'local-operator',taskId:d.id,purpose:'proposal'});
  }],
  ['global quota','BEFORE UPDATE ON model_call_budget',f=>()=>f.store.reserveModelCall(100)],
  ['session creation','BEFORE INSERT ON visitor_sessions',f=>()=>f.store.saveSession({tokenHash:'test-token',ownerId:'test-owner',csrf:'test-csrf',expiresAtMs:Date.now()+10000})],
  ['session revocation','BEFORE DELETE ON visitor_sessions',f=>{
    f.store.saveSession({tokenHash:'test-token',ownerId:'test-owner',csrf:'test-csrf',expiresAtMs:Date.now()+10000});return ()=>f.store.revokeSession('test-token');
  }],
  ['campaign creation','BEFORE INSERT ON campaigns',f=>()=>f.store.createCampaign(config)],
  ['capture session registration','BEFORE INSERT ON atk_capture_sessions',f=>()=>f.store.openATKCaptureSession(binding)],
  ['observation quarantine','BEFORE INSERT ON observation_review_actions',f=>{
    f.store.captureATKToolObservation(atkRecord());
    const review=f.store.reviewObservation({kind:'atk',id:'observation-1'});
    return ()=>f.store.quarantineATKObservation({id:'observation-1',expectedReviewHash:review.reviewHash});
  }],
  ['campaign pause','BEFORE INSERT ON campaign_events',f=>{f.store.createCampaign(config);return ()=>f.store.pauseCampaign(config.id);}],
  ['observation capture','BEFORE INSERT ON observations',async f=>{
    const d=f.engine.draft(fields),task=f.engine.approve({draftId:d.id,policyHash:d.policyHash,acknowledgement:true});
    await f.engine.run(task.id);const intent=f.store.get(task.id).ledger.intents[0];
    return ()=>f.store.captureObservation({taskId:task.id,intentId:intent.id,source:'fixture-fill',payload:{tradeId:'capacity-test'}});
  }],
];
for(const [name,trigger,prepare] of cases)test('SQLite FULL fails closed at '+name,async t=>{
  const f=fixture(t),action=await prepare(f);limit(f.store,trigger);const before=capture(f.store);
  assert.throws(action,error=>error.errcode===13);
  assert.deepEqual(capture(f.store),before);
  assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(f.store.globalSafetyStatus().paused,true);
  assert.throws(()=>f.store.assertNewWorkAllowed(),{code:'GLOBAL_PAUSED'});
});

test('SQLite FULL in capture receipt rolls back the observation, sanitizes error and pauses',t=>{
  const f=fixture(t),session=f.store.openATKCaptureSession(binding),record=atkRecord();
  limit(f.store,'BEFORE INSERT ON atk_capture_receipts');const before=capture(f.store);
  assert.throws(()=>session.capture(record),error=>error.code==='ATK_OBSERVATION_STORAGE_FAILED' && error.errcode===undefined);
  assert.deepEqual(capture(f.store),before);
  assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(f.store.globalSafetyStatus().paused,true);
  assert.throws(()=>f.store.assertNewWorkAllowed(),{code:'GLOBAL_PAUSED'});
});

test('SQLite FULL in restore leaves target empty and paused, source unchanged',t=>{
  const source=fixture(t),target=fixture(t);source.engine.draft(fields);source.store.pauseGlobal();
  const backup=source.store.exportRecoverySnapshot(Date.now()),original=capture(source.store);
  limit(target.store,'BEFORE INSERT ON policy_workflows');const empty=capture(target.store);
  assert.throws(()=>target.store.restoreRecoverySnapshot(backup),error=>error.errcode===13);
  assert.deepEqual(capture(target.store),empty);assert.deepEqual(capture(source.store),original);
  assert.equal(target.store.globalSafetyStatus().paused,true);
});

test('failed BEGIN and failed durable pause retain original I/O error and RAM safety latch',t=>{
  const f=fixture(t),exec=f.store.db.exec.bind(f.store.db);
  const error=Object.assign(new Error('test I/O failure'),{code:'ERR_SQLITE_ERROR',errcode:10});
  f.store.db.exec=sql=>{if(sql.startsWith('BEGIN'))throw error;return exec(sql);};
  assert.throws(()=>f.engine.draft(fields),actual=>actual===error);
  assert.equal(f.store.globalSafetyStatus().paused,true);
  assert.equal(f.store.globalSafetyStatus().durablePaused,false);
  f.store.db.exec=exec;
});

// Real SQLite capacity error in a bounded temporary DB, never physical disk filling.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';

test('SQLite FULL retains original error, rolls back task/audit/outbox and pauses new work',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-sqlite-capacity-')),store=new Store(directory);
  try {
    const engine=new Engine(store,new FixturePlanner());
    const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'});
    const task=engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
    await engine.run(task.id);engine.scenario(task.id,'partial');
    const snapshot=()=>({task:store.get(task.id),receipts:store.receipts(task.id),
      outbox:store.db.prepare('SELECT * FROM receipt_outbox').all(),observations:store.observations(task.id)});
    const before=snapshot(),pageCount=store.db.prepare('PRAGMA page_count').get().page_count;
    assert.ok(Number.isSafeInteger(pageCount) && pageCount>0 && pageCount<4096);
    store.db.exec('PRAGMA max_page_count='+pageCount);
    assert.throws(()=>store.update(task.id,state=>{
      state.capacityTest='x'.repeat(1024*1024);
      return {decision:{kind:'CAPACITY_TEST_MUST_ROLL_BACK'}};
    }),error=>error.errcode===13,'Original SQLITE_FULL must not be replaced by a ROLLBACK error');
    assert.deepEqual(snapshot(),before);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(engine.view(task.id).auditVerified,true);
    assert.equal(store.globalSafetyStatus().paused,true);
    assert.throws(()=>store.assertNewWorkAllowed(),{code:'GLOBAL_PAUSED'});
  } finally {
    store.close();
    const target=realpathSync(directory);assert.equal(dirname(target),realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('pactway-sqlite-capacity-'));
    rmSync(target,{recursive:true,force:true});
  }
});

test('SQLite FULL during approval leaves no consumed draft, task, receipt or outbox entry',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-sqlite-capacity-')),store=new Store(directory);
  try {
    const engine=new Engine(store,new FixturePlanner());
    const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'});
    const before=store.policyWorkflow(draft.id,'local-operator');
    // Test-only trigger forces a real allocation during the product approval transaction.
    store.db.exec('CREATE TABLE capacity_probe(payload BLOB); CREATE TEMP TRIGGER capacity_probe_insert BEFORE INSERT ON tasks BEGIN INSERT INTO capacity_probe VALUES(zeroblob(1048576)); END;');
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    assert.ok(Number.isSafeInteger(pages) && pages>0 && pages<4096);
    store.db.exec('PRAGMA max_page_count='+pages);
    assert.throws(()=>engine.approveAndEnqueue({draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true}),
      error=>error.errcode===13);
    assert.deepEqual(store.policyWorkflow(draft.id,'local-operator'),before);
    assert.equal(store.get(draft.id),null);assert.equal(store.receipts(draft.id).length,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receipt_outbox').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM capacity_probe').get().n,0);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(store.globalSafetyStatus().paused,true);
  } finally {
    store.close();
    const target=realpathSync(directory);assert.equal(dirname(target),realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('pactway-sqlite-capacity-'));
    rmSync(target,{recursive:true,force:true});
  }
});

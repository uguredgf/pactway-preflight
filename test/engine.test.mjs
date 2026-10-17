// Test source only; not executed in the coding-only development session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.mjs';
import { Engine } from '../src/engine.mjs';
import { FixturePlanner } from '../src/planner.mjs';
import { parseDecimal } from '../src/domain/money.mjs';
import { verifyAuditChain } from '../src/audit/commitments.mjs';

function setup(planner=new FixturePlanner()) {
  const directory=mkdtempSync(join(tmpdir(),'mandateguard-test-'));
  const store=new Store(directory), engine=new Engine(store,planner);
  function create() {
    const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
    return engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
  }
  return {store,engine,create,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('veto, autonomous revision and a reserved fixture order share one auditable history',async()=>{
  const env=setup();
  try {
    const initial=env.create(), result=await env.engine.run(initial.id);
    assert.equal(result.attempts,2);
    assert.equal(result.ledger.intents.length,1);
    assert.equal(result.ledger.intents[0].state,'OPEN');
    assert.ok(result.receipts.some(receipt=>receipt.source.decision.kind==='VETO'));
    assert.ok(result.receipts.some(receipt=>receipt.source.decision.kind==='ACCEPTED_AND_RESERVED'));
    const summary=result.summary;
    assert.equal(parseDecimal(summary.spent)+parseDecimal(summary.reserved)+parseDecimal(summary.remaining),parseDecimal('100'));
    assert.equal(result.auditVerified,true);
    assert.equal(verifyAuditChain({policyCommitment:result.auditPolicy,receipts:result.receipts.slice(0,-1),expectedHead:result.auditHead}),false);
    assert.equal(verifyAuditChain({policyCommitment:result.auditPolicy,receipts:[],expectedHead:result.auditHead}),false);
    assert.equal(result.chainState,'LOCAL_ONLY');
    const tampered=structuredClone(result.receipts);tampered[0].source.decision.policy.maxShare='1';
    assert.equal(verifyAuditChain({policyCommitment:result.auditPolicy,receipts:tampered}),false);
  } finally {env.close();}
});

test('recovery preserves a stop during model generation, including a late result',async()=>{
  let resolveModel;
  const env=setup({kind:'test',propose:()=>new Promise(resolve=>{resolveModel=resolve;})});
  try {
    const task=env.create(),pending=env.engine.advance(task.id);
    env.engine.stop(task.id);env.engine.recover();
    assert.equal(env.engine.view(task.id).ledger.phase,'STOPPED');
    resolveModel({action:'propose',price:'24.80',size:'0.1',reason:'Late result'});
    const result=await pending;
    assert.equal(result.ledger.phase,'STOPPED');assert.equal(result.ledger.intents.length,0);
  }finally{env.close();}
});

test('a lost audit tail is detected and cannot be silently replaced by the next decision',async()=>{
  const env=setup();
  try {
    const task=env.create(),result=await env.engine.run(task.id);
    env.store.db.prepare('DELETE FROM events WHERE task_id=? AND sequence=?').run(task.id,Number(result.auditHead.sequence));
    assert.equal(env.engine.view(task.id).auditVerified,false);
    assert.throws(()=>env.store.update(task.id,()=>({decision:{kind:'SHOULD_NOT_REANCHOR'}})),/Kayıt sonu/);
    assert.deepEqual(env.store.get(task.id).auditHead,result.auditHead);
  }finally{env.close();}
});

test('duplicate partial fill does not double spend and cancel request holds the remaining reserve',async()=>{
  const env=setup();
  try {
    const task=env.create();await env.engine.run(task.id);
    const first=env.engine.scenario(task.id,'partial');
    const duplicate=env.engine.scenario(task.id,'partial');
    assert.equal(duplicate.summary.spent,first.summary.spent);
    assert.equal(duplicate.summary.reserved,first.summary.reserved);
    const pending=env.engine.stop(task.id);
    assert.equal(pending.summary.reserved,first.summary.reserved);
    assert.equal(pending.ledger.intents[0].state,'CANCEL_PENDING');
    const terminal=env.engine.scenario(task.id,'confirm-cancel');
    assert.equal(terminal.summary.reserved,'0');
    assert.equal(terminal.summary.spent,first.summary.spent);
    assert.equal(terminal.ledger.phase,'STOPPED');
  } finally {env.close();}
});

test('a stop wins over a late local model result',async()=>{
  let resolveModel;
  const planner={kind:'test',propose:()=>new Promise(resolve=>{resolveModel=resolve;})};
  const env=setup(planner);
  try {
    const task=env.create(), pending=env.engine.advance(task.id);
    env.engine.stop(task.id);
    resolveModel({action:'propose',price:'24.80',size:'0.1',reason:'Late response'});
    const result=await pending;
    assert.equal(result.ledger.stopRequested,true);
    assert.equal(result.ledger.intents.length,0);
    assert.equal(result.summary.reserved,'0');
    assert.equal(result.summary.spent,'0');
    assert.ok(result.receipts.some(receipt=>receipt.source.decision.kind==='LATE_PROPOSAL_DISCARDED'));
  } finally {env.close();}
});

test('unknown fixture outcomes hold the slot and the reservation',async()=>{
  const env=setup();
  try {
    const task=env.create();await env.engine.run(task.id);
    const unknown=env.engine.scenario(task.id,'unknown');
    await assert.rejects(()=>env.engine.advance(task.id));
    assert.ok(parseDecimal(unknown.summary.reserved)>0n);
    assert.equal(env.engine.view(task.id).ledger.intents.length,1);
    assert.throws(()=>env.create(),/mevcut örnek görevi/);
  } finally {env.close();}
});

test('a conflicting external observation is durable before projection rejects it and reads stay available',async()=>{
  const env=setup();
  try {
    const task=env.create();await env.engine.run(task.id);
    const initial=env.engine.scenario(task.id,'partial'),intent=initial.ledger.intents[0],fill=intent.fills[0];
    const result=env.engine.observeFill(task.id,intent.id,{...fill,quoteNotional:'99'});
    assert.equal(result.summary.spent,initial.summary.spent);
    assert.equal(result.observationBlocked,true);
    assert.equal(result.observations[0].status,'QUARANTINED');
    assert.equal(env.store.observationPayload(result.observations[0].id).quoteNotional,'99');
    assert.equal(env.engine.stop(task.id).ledger.stopRequested,true);
  }finally{env.close();}
});

test('final fixture submission uses a fresh independent snapshot and rejects a changed balance',async()=>{
  const env=setup({kind:'test',propose:async()=>({action:'propose',price:'24.80',size:'0.1',reason:'Example'})});
  try {
    const task=env.create(),original=env.engine.snapshot.bind(env.engine);let observations=0;
    env.engine.snapshot=state=>{observations++;return {...original(state),...(observations===3?{availableQuote:'0'}:{})};};
    const result=await env.engine.advance(task.id);
    assert.equal(result.ledger.intents[0].submissionAttempted,false);
    assert.equal(result.ledger.intents[0].settled,true);
    assert.equal(result.receipts.at(-1).source.decision.kind,'PRE_SUBMIT_BLOCKED');
  }finally{env.close();}
});

test('an earlier corrupt receipt cannot pass a valid latest-head mutation gate',()=>{
  const env=setup();
  try {
    const task=env.create();env.store.update(task.id,()=>({decision:{kind:'SECOND_EVENT'}}));
    const first=env.store.receipts(task.id)[0];first.source.decision.kind='ALTERED';
    env.store.db.prepare('UPDATE events SET receipt=? WHERE task_id=? AND sequence=1').run(JSON.stringify(first),task.id);
    assert.equal(env.engine.view(task.id).auditVerified,false);
    assert.throws(()=>env.store.update(task.id,()=>({decision:{kind:'MUST_NOT_APPEND'}})),/Karar kayıtları/);
  }finally{env.close();}
});

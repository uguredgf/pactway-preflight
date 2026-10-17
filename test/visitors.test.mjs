// Acceptance test SOURCES only. Not executed in the code-only development session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {VisitorAccess,validateCookieName} from '../src/access.mjs';
import {ExecutionQueue} from '../src/execution-queue.mjs';

function setup() {
  const directory=mkdtempSync(join(tmpdir(),'mandateguard-visitors-'));
  const store=new Store(directory),engine=new Engine(store,new FixturePlanner());
  const queue=new ExecutionQueue(store,engine);
  const access=new VisitorAccess(store,{shared:true,inviteCode:'test-only-invitation-code-123456'});
  function visitor(){let cookie;const session=access.create({setHeader(name,value){if(name==='Set-Cookie')cookie=value;}},'test-only-invitation-code-123456');
    return {session,cookie,request:{headers:{cookie:cookie.split(';')[0]}}};}
  function task(ownerId){const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'},ownerId);
    return engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true},ownerId);}
  return {store,engine,queue,access,visitor,task,close(){queue.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('explicit cookie names are validated while legacy defaults remain compatible',()=>{
  assert.equal(validateCookieName('mg-session'), 'mg-session');
  assert.equal(validateCookieName('__Host-mg-session',{shared:true}), '__Host-mg-session');
  for(const value of ['', 'mg.session', 'mg-session\r\nInjected: yes', 'a'.repeat(129)])
    assert.throws(()=>validateCookieName(value),/cookie adı geçersiz/);
  assert.throws(()=>validateCookieName('mg-session',{shared:true}),/__Host-/);
  assert.throws(()=>validateCookieName('__Host-mg-session'),/__Host-/);
});

test('same-host ports keep independent sessions and logout clears only its namespace',()=>{
  const firstDirectory=mkdtempSync(join(tmpdir(),'mandateguard-cookie-port-a-'));
  const secondDirectory=mkdtempSync(join(tmpdir(),'mandateguard-cookie-port-b-'));
  const firstStore=new Store(firstDirectory),secondStore=new Store(secondDirectory);
  const first=new VisitorAccess(firstStore,{cookieName:'mg-session-18776'});
  const second=new VisitorAccess(secondStore,{cookieName:'mg-session-18777'});
  const headers=[];
  const response={setHeader(name,value){if(name==='Set-Cookie')headers.push(value);}};
  try {
    const firstSession=first.create(response),secondSession=second.create(response);
    const browserCookie=headers.map(value=>value.split(';')[0]).join('; ');
    const request={headers:{cookie:browserCookie}};
    assert.equal(first.read(request).ownerId,firstSession.ownerId);
    assert.equal(second.read(request).ownerId,secondSession.ownerId);

    const logoutHeaders=[];
    first.revoke({setHeader(name,value){if(name==='Set-Cookie')logoutHeaders.push(value);}},firstSession);
    assert.match(logoutHeaders[0],/^mg-session-18776=;/);
    assert.equal(first.read(request),null);
    assert.equal(second.read(request).ownerId,secondSession.ownerId);
  }finally{
    firstStore.close();secondStore.close();
    rmSync(firstDirectory,{recursive:true,force:true});rmSync(secondDirectory,{recursive:true,force:true});
  }
});

test('one visitor cannot adopt another draft, read a task or download its audit through ownership gate',()=>{
  const env=setup();
  try {
    const a=env.visitor(),b=env.visitor();
    assert.match(a.cookie,/HttpOnly; SameSite=Strict;.*Secure/);
    assert.equal(env.access.read(a.request).ownerId,a.session.ownerId);
    const draft=env.engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'},a.session.ownerId);
    assert.throws(()=>env.engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true},b.session.ownerId));
    const task=env.engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true},a.session.ownerId);
    assert.equal(env.access.owns(a.session,task.id).id,task.id);
    assert.throws(()=>env.access.owns(b.session,task.id),error=>error.status===404);
    assert.equal(env.store.list(b.session.ownerId).length,0);
    env.access.revoke({setHeader(){}},a.session);
    assert.equal(env.access.read(a.request),null);
  }finally{env.close();}
});

test('only three jobs can wait, with bounded queue expiry and admission blocked by unknown',async()=>{
  const env=setup();
  try {
    const tasks=Array.from({length:4},()=>env.task(env.visitor().session.ownerId));
    for(const task of tasks.slice(0,3))env.queue.enqueue(task.id);
    assert.throws(()=>env.queue.enqueue(tasks[3].id),/Üç bekleyen/);
    assert.ok(env.store.get(tasks[0].id).queue.expiresAtMs<=Date.now()+120000);
    const first=env.queue.waiting()[0];await env.queue.pump();env.engine.scenario(first.id,'unknown');
    assert.throws(()=>env.queue.enqueue(tasks[3].id),/Belirsiz işlem/);
  }finally{env.close();}
});

test('expired waiting jobs stop without model execution',async()=>{
  const env=setup();
  try {
    const task=env.task(env.visitor().session.ownerId);env.queue.enqueue(task.id);
    env.store.update(task.id,state=>{state.queue.expiresAtMs=Date.now()-1;});
    await env.queue.pump();
    assert.equal(env.engine.view(task.id).ledger.phase,'STOPPED');
    assert.equal(env.engine.view(task.id).attempts,0);assert.equal(env.queue.view(task.id).queueInfo.state,'CANCELLED');
  }finally{env.close();}
});

test('queue close drains a pending model before storage can be closed',async()=>{
  const env=setup();let resolveModel;
  try {
    env.engine.planner={kind:'test',propose:()=>new Promise(resolve=>{resolveModel=resolve;})};
    const task=env.task(env.visitor().session.ownerId);env.queue.enqueue(task.id);
    const running=env.queue.pump();let drained=false;
    const closing=env.queue.close().then(()=>{drained=true;});
    env.engine.stop(task.id);await Promise.resolve();assert.equal(drained,false);
    resolveModel({action:'propose',price:'24.80',size:'0.1',reason:'Late proposal'});
    await running;await closing;
    assert.equal(drained,true);assert.equal(env.engine.view(task.id).ledger.intents.length,0);
  }finally{env.close();}
});

test('different visitors queue independently, unknown and cancel ACK hold the single lane until reconciliation',async()=>{
  const env=setup();
  try {
    const a=env.visitor(),b=env.visitor(),first=env.task(a.session.ownerId),second=env.task(b.session.ownerId);
    env.queue.enqueue(first.id);await env.queue.pump();
    env.queue.enqueue(second.id);await env.queue.pump();
    assert.equal(env.queue.view(first.id).ledger.intents.length,1);
    assert.equal(env.queue.view(second.id).queueInfo.position,1);
    assert.equal(env.queue.view(second.id).ledger.intents.length,0);
    env.engine.scenario(first.id,'unknown');await env.queue.pump();
    assert.equal(env.queue.view(second.id).ledger.intents.length,0);
    env.engine.stop(first.id);await env.queue.pump();
    assert.equal(env.queue.view(second.id).ledger.intents.length,0);
    env.engine.scenario(first.id,'confirm-cancel');await env.queue.pump();
    assert.equal(env.queue.view(first.id).summary.reserved,'0');
    assert.equal(env.queue.view(second.id).ledger.intents.length,1);
  }finally{env.close();}
});

test('restart pauses queued work and holds an observed active intent without submitting another order',async()=>{
  const env=setup();
  try {
    const first=env.task(env.visitor().session.ownerId),second=env.task(env.visitor().session.ownerId);
    env.queue.enqueue(first.id);await env.queue.pump();env.queue.enqueue(second.id);
    env.engine.recover();env.queue.recover();await env.queue.pump();
    assert.equal(env.queue.view(first.id).queueInfo.state,'BLOCKED');
    assert.equal(env.queue.view(first.id).ledger.intents[0].state,'UNKNOWN');
    assert.equal(env.queue.view(second.id).queueInfo.state,'CANCELLED');
    assert.equal(env.queue.view(second.id).ledger.intents.length,0);
  }finally{env.close();}
});

test('session expiry during model generation cannot reserve or submit an intent',async()=>{
  const env=setup();let resolveProposal,authorized=true;
  try {
    const planner={kind:'test',propose:()=>new Promise(resolve=>{resolveProposal=resolve;})};
    const engine=new Engine(env.store,planner,{isExecutionAuthorized:()=>authorized});
    const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
    const task=engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
    const pending=engine.advance(task.id);authorized=false;
    resolveProposal({action:'propose',price:'24.80',size:'0.1',reason:'Returned after expiry'});
    const next=await pending;
    assert.equal(next.ledger.intents.length,0);assert.equal(next.ledger.stopRequested,true);
    assert.equal(next.summary.reserved,'0');
    assert.ok(next.receipts.some(receipt=>receipt.source.decision.kind==='OWNER_SESSION_ENDED'));
  }finally{env.close();}
});

test('fixture recovery after restart and prior stop preserves partial spend and clears only unused reserve',async()=>{
  const env=setup();
  try {
    const task=env.task(env.visitor().session.ownerId);env.queue.enqueue(task.id);await env.queue.pump();
    const partial=env.engine.scenario(task.id,'partial');env.engine.stop(task.id);
    env.engine.recover();env.queue.recover();
    assert.equal(env.engine.view(task.id).ledger.intents[0].state,'UNKNOWN');
    env.engine.stop(task.id);const done=env.engine.scenario(task.id,'confirm-cancel');
    assert.equal(done.summary.spent,partial.summary.spent);assert.equal(done.summary.reserved,'0');
  }finally{env.close();}
});

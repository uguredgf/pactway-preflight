// Explicit local child-process crash acceptance; NOT power-loss or real exchange acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,lstatSync,readFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Store} from '../../src/persistence/store.mjs';
import {Engine} from '../../src/engine.mjs';
import {ExecutionQueue} from '../../src/execution-queue.mjs';
import {ledgerSummary} from '../../src/domain/ledger.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),prefix='pactway-process-crash-';
function validated(directory){
  const target=realpathSync(directory);
  assert.equal(dirname(target),realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith(prefix));
  assert.equal(lstatSync(directory).isSymbolicLink(),false);
  return target;
}
function hashes(directory){
  return Object.fromEntries(['mandateguard.db','mandateguard.db-wal','pactway.initialized','owner.lock'].map(name=>{
    const file=join(directory,name);
    return [name,existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null];
  }));
}
function snapshot(store,id){return {task:store.get(id),draft:store.policyWorkflow(id,'local-operator'),
  receipts:store.receipts(id),observations:store.observations(id),usage:store.modelWorkflowUsage(id),
  outbox:store.db.prepare('SELECT * FROM receipt_outbox ORDER BY task_id,sequence').all(),
  providerBudget:store.db.prepare('SELECT * FROM model_call_budget ORDER BY provider').all()};}
const plain=value=>JSON.parse(JSON.stringify(value));

for(const mode of ['approval-before-commit','approval-after-commit','partial-after-commit','update-before-commit']){
  test('abrupt process termination: '+mode,{timeout:25000},async t=>{
    const directory=mkdtempSync(join(tmpdir(),prefix));
    let child,closed,store;
    t.after(async()=>{
      store?.close();
      if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
      if(closed)await closed;
      rmSync(validated(directory),{recursive:true,force:true,maxRetries:4,retryDelay:100});
    });
    const env={};
    for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
    child=spawn(process.execPath,['test/support/crash-fixture-worker.mjs',directory,mode],
      {cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    const boundary=await new Promise((resolve,reject)=>{
      let output='',errors='';
      const timer=setTimeout(()=>reject(Error('Crash boundary timeout: '+errors)),10000);
      const fail=error=>{clearTimeout(timer);reject(error);};
      child.once('error',fail);
      child.once('exit',()=>fail(Error('Child exited before boundary: '+errors)));
      child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000);});
      child.stdout.on('data',chunk=>{
        output+=chunk;
        if(output.includes('\n')){
          clearTimeout(timer);
          try{resolve(JSON.parse(output.slice(0,output.indexOf('\n'))));}catch(error){reject(error);}
        }
      });
    });
    assert.equal(boundary.pid,child.pid);
    assert.equal(boundary.stage,mode.endsWith('before-commit')?'before-commit':mode==='approval-after-commit'?'after-approval':'after-partial');
    if(mode==='approval-before-commit'){
      assert.equal(boundary.before.task,null);
      assert.equal(boundary.atBoundary.task.id,boundary.request.draftId);
      assert.equal(boundary.atBoundary.draft.taskId,boundary.request.draftId);
      assert.equal(boundary.atBoundary.receipts.length,1);assert.equal(boundary.atBoundary.outbox.length,1);
    }else if(mode==='update-before-commit'){
      assert.equal(boundary.atBoundary.task.lastRejection,'UNCOMMITTED_CRASH_TEST');
      assert.equal(boundary.atBoundary.receipts.length,boundary.before.receipts.length+1);
      assert.equal(boundary.atBoundary.outbox.length,boundary.before.outbox.length+1);
    }
    assert.equal(child.kill('SIGKILL'),true);await closed;
    assert.ok(child.exitCode!==null || child.signalCode!==null);

    // Product restart must refuse the crash lock and leave DB/WAL/marker untouched.
    const target=validated(directory),lock=join(target,'owner.lock'),info=lstatSync(lock);
    assert.equal(info.isFile(),true);assert.equal(info.isSymbolicLink(),false);assert.equal(info.nlink,1);
    assert.equal(JSON.parse(readFileSync(lock,'utf8')).pid,child.pid);
    const beforeRefusal=hashes(target);
    assert.throws(()=>new Store(target),{code:'EEXIST'});
    assert.deepEqual(hashes(target),beforeRefusal);

    // Deliberate recovery of THIS test child only, after close: archive, never auto-delete a lock.
    const archived=join(target,'owner.lock.crash-evidence');assert.equal(existsSync(archived),false);
    renameSync(lock,archived);
    store=new Store(target);
    assert.equal(store.globalSafetyStatus().reason,'RESTART_RECONCILIATION_REQUIRED');
    assert.equal(store.recoveryRequired(),true);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const id=boundary.request.draftId;
    assert.deepEqual(plain(snapshot(store,id)),boundary.before,'Committed state retained; uncommitted state absent');
    let plannerCalls=0;
    const engine=new Engine(store,{kind:'fixture',async propose(){plannerCalls++;throw Error('Must not execute after crash');}});
    const queue=new ExecutionQueue(store,engine);
    engine.recover();queue.recover();await queue.pump();
    assert.equal(plannerCalls,0);assert.equal(store.globalSafetyStatus().paused,true);
    if(mode==='approval-before-commit'){
      assert.equal(store.get(id),null);assert.equal(store.policyWorkflow(id,'local-operator').taskId,null);
      assert.equal(store.receipts(id).length,0);
      assert.throws(()=>engine.approveAndEnqueue(boundary.request),/duraklatıldı/);
    }else{
      const view=engine.view(id);assert.equal(view.auditVerified,true);
      const replay=engine.approveAndEnqueue(boundary.request);
      assert.equal(replay.replayed,true);assert.equal(replay.task.id,id);assert.equal(store.list().length,1);
      assert.equal(store.receipts(id).filter(r=>r.source.decision.kind==='POLICY_APPROVED_AND_QUEUED').length,1);
      assert.equal(view.queue.state,mode==='approval-after-commit'?'CANCELLED':'BLOCKED');
      if(mode!=='approval-after-commit'){
        assert.equal(view.ledger.intents.length,1);assert.equal(view.ledger.intents[0].state,'UNKNOWN');
        const previousSummary=ledgerSummary(boundary.before.task.ledger);
        assert.equal(view.summary.spent,previousSummary.spent);
        assert.equal(view.summary.reserved,previousSummary.reserved);
        assert.equal(view.summary.remaining,previousSummary.remaining);
        assert.deepEqual(view.ledger.intents[0].fills,boundary.before.task.ledger.intents[0].fills);
        assert.notEqual(view.summary.reserved,'0');
        assert.equal(store.receipts(id).filter(r=>r.source.decision.kind==='FIXTURE_SUBMISSION_ATTEMPT').length,1);
      }
      assert.deepEqual(plain(store.modelWorkflowUsage(id)),boundary.before.usage);
      assert.deepEqual(plain(store.db.prepare('SELECT * FROM model_call_budget ORDER BY provider').all()),boundary.before.providerBudget);
      assert.equal(store.receipts(id).some(r=>r.source.decision.kind==='UNCOMMITTED_CRASH_TEST'),false);
    }
    await queue.close();
  });
}

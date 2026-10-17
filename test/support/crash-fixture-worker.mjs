// Invoked only by the explicit process-crash integration test. No server/SDK/provider.
import {writeSync} from 'node:fs';
import {Store} from '../../src/persistence/store.mjs';
import {Engine} from '../../src/engine.mjs';
import {FixturePlanner} from '../../src/planner.mjs';
import {ExecutionQueue} from '../../src/execution-queue.mjs';

const [directory,mode]=process.argv.slice(2);
if(!['approval-before-commit','approval-after-commit','partial-after-commit','update-before-commit'].includes(mode))throw Error('Invalid crash fixture mode');
const store=new Store(directory),engine=new Engine(store,new FixturePlanner()),queue=new ExecutionQueue(store,engine);
const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'});
const request={draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true};
const snapshot=()=>({task:store.get(draft.id),draft:store.policyWorkflow(draft.id,'local-operator'),
  receipts:store.receipts(draft.id),observations:store.observations(draft.id),usage:store.modelWorkflowUsage(draft.id),
  outbox:store.db.prepare('SELECT * FROM receipt_outbox ORDER BY task_id,sequence').all(),
  providerBudget:store.db.prepare('SELECT * FROM model_call_budget ORDER BY provider').all()});
function halt(stage,before){
  // Synchronous pipe write acknowledges the exact boundary to the parent before blocking.
  writeSync(1,JSON.stringify({stage,pid:process.pid,request,before,atBoundary:snapshot()})+'\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  throw Error('Crash fixture must be terminated by its parent');
}
function interceptNextCommit(before){
  const exec=store.db.exec.bind(store.db);
  store.db.exec=sql=>{
    if(sql==='COMMIT')halt('before-commit',before);
    return exec(sql);
  };
}
if(mode==='approval-before-commit')interceptNextCommit(snapshot());
engine.approveAndEnqueue(request);
if(mode==='approval-after-commit')halt('after-approval',snapshot());
await queue.pump();
engine.scenario(draft.id,'partial');
store.reserveModelCall(100);
const before=snapshot();
if(mode==='partial-after-commit')halt('after-partial',before);
if(mode==='update-before-commit'){
  interceptNextCommit(before);
  store.update(draft.id,state=>{
    state.lastRejection='UNCOMMITTED_CRASH_TEST';
    return {decision:{kind:'UNCOMMITTED_CRASH_TEST'}};
  });
}
throw Error('Unexpected crash fixture fallthrough');

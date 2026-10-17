// Actual app.mjs behavior with doubles: not browser E2E or real exchange acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';
import {makeApproval} from '../public/ui-state.mjs';

const id='12345678-1234-1234-1234-123456789abc';
const status={executionMode:'fixture',extractorAvailable:false,safety:{paused:false},atk:{state:'NOT_CONNECTED'},avalanche:{state:'NOT_DEPLOYED'}};
const policy={executionMode:'fixture',accountId:'fixture',budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
  approvedAtMs:500,expiresAtMs:600000,orderLifetimeMs:10000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:1000,
  quoteFeeRateMax:'0.001',quoteFeeFixedMax:'0',baseFeeRateMax:'0.001'};
const draft=()=>({id,revision:2,policyHash:'a'.repeat(64),ready:true,missing:[],unresolved:[],
  extractionState:'NOT_REQUESTED',validUntilMs:500000,fields:{},policy});
const task=(taskId='recovered-task')=>({id:taskId,revision:1,mode:'fixture',plannerKind:'fixture',approvalRequest:{},
  policy,approvedPolicyHash:'a'.repeat(64),ledger:{phase:'WAITING',intents:[],stopRequested:false},
  queueInfo:{state:'QUEUED',position:1},summary:{spent:'0',reserved:'0',remaining:'100'},receipts:[],auditVerified:true});
const pending=()=>makeApproval(draft());
const stored=()=>[['mg-pending-approval',JSON.stringify(pending())]];
const boot=(tasks=[])=>({csrf:'fixture-csrf',status,tasks,drafts:[{id,ready:true}]});
const reply=body=>({body});
const posts=h=>h.calls.filter(call=>call.method==='POST');
const shared=request=>request.path==='/api/status'?reply(status):request.path==='/api/work'?reply(boot()):undefined;

test('reload recovers the committed task via GET without falling back to stale bootstrap tasks',async()=>{
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot([{id:'older-task'}]));
    if(r.path==='/api/policy/drafts/'+id)return reply({...draft(),taskId:'recovered-task'});
    if(r.path.startsWith('/api/tasks/'))return reply(task(r.path.split('/').at(-1)));
    return shared(r);
  }});
  assert.equal(h.storage.get('mg-task-id'),'recovered-task');
  assert.equal(h.storage.has('mg-pending-approval'),false);
  assert.equal(h.storage.has('mg-draft-id'),false);
  assert.equal(h.get('workspace').hidden,false);
  assert.equal(h.get('approval').open,false);
  assert.equal(h.calls.some(r=>r.path==='/api/tasks/older-task'),false);
  assert.equal(posts(h).length,0);
});

test('reload with unresolved approval locks edits and requires explicit byte-identical retry',async()=>{
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply(draft());
    if(r.path==='/api/tasks/approve-and-enqueue')return reply(task());
    return shared(r);
  }});
  assert.equal(posts(h).length,0);
  for(const name of ['ack','save-draft','close-approval','draft-button','saved-tasks'])assert.equal(h.get(name).disabled,true,name);
  assert.equal((await h.fire('approval','cancel')).defaultPrevented,true);
  await h.fire('close-approval','click');assert.equal(h.get('approval').open,true);
  await h.poll();assert.equal(posts(h).length,0);
  await h.fire('approve','click');
  assert.equal(posts(h).length,1);
  assert.equal(posts(h)[0].body,JSON.stringify(pending()));
  assert.equal(posts(h)[0].headers['X-MG-CSRF'],'fixture-csrf');
  assert.equal(h.storage.has('mg-pending-approval'),false);
});

test('lost approval response keeps original request across reload and never auto-resubmits',async()=>{
  const h=await startController({stored:[['mg-draft-id',id]],respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply(draft());
    if(r.path==='/api/tasks/approve-and-enqueue')return {error:Error('Response lost after commit')};
    return shared(r);
  }});
  h.get('ack').checked=true;await h.fire('ack','change');await h.fire('approve','click');
  assert.match(h.get('approval-error').textContent,/sonucu bilinmiyor/);
  assert.equal(h.get('approve').disabled,true);
  assert.equal(h.storage.get('mg-pending-approval'),posts(h)[0].body);
  await h.poll();assert.equal(posts(h).length,1);
  const reloaded=await startController({stored:[...h.storage],respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply({...draft(),taskId:'recovered-task'});
    if(r.path==='/api/tasks/recovered-task')return reply(task());
    return shared(r);
  }});
  assert.equal(posts(reloaded).length,0);
  assert.equal(reloaded.storage.get('mg-task-id'),'recovered-task');
});

test('failed recovery GET keeps new work blocked until a later GET verifies the task',async()=>{
  let reads=0;
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return ++reads===1?{error:Error('Offline')}:reply({...draft(),taskId:'recovered-task'});
    if(r.path==='/api/tasks/recovered-task')return reply(task());
    return shared(r);
  }});
  assert.equal(h.get('draft-button').disabled,true);assert.equal(h.storage.has('mg-pending-approval'),true);
  await h.poll();assert.equal(reads,2);
  assert.equal(h.storage.get('mg-task-id'),'recovered-task');assert.equal(posts(h).length,0);
});

test('definitive conflict clears pending approval but requires a new review acknowledgement',async()=>{
  let reads=0;
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply({...draft(),revision:++reads===1?2:3});
    if(r.path==='/api/tasks/approve-and-enqueue')return {status:409,body:{error:'Taslak sürümü değişti.'}};
    return shared(r);
  }});
  await h.fire('approve','click');
  assert.equal(h.storage.has('mg-pending-approval'),false);assert.equal(reads,2);
  assert.equal(h.get('ack').checked,false);assert.equal(h.get('approve').disabled,true);
  await h.fire('approve','click');assert.equal(posts(h).length,1);
});

test('expired pending approval can check its original result, not approve a new policy',async()=>{
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply({...draft(),validUntilMs:900});
    if(r.path==='/api/tasks/approve-and-enqueue')return reply({...task(),approvalReplayed:true});
    return shared(r);
  }});
  assert.equal(h.get('ack').disabled,true);assert.equal(h.get('approve').disabled,false);
  await h.fire('approve','click');assert.equal(posts(h)[0].body,JSON.stringify(pending()));
  assert.match(h.get('toast').textContent,/yeniden başlatılmadı/);
});

test('recovery 401 clears private screen and pending storage without issuing a mutation',async()=>{
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return {status:401,body:{error:'Session ended',inviteRequired:true}};
    return shared(r);
  }});
  assert.equal(h.get('visitor-access').hidden,false);assert.equal(h.get('workspace').hidden,true);
  assert.equal(h.storage.has('mg-pending-approval'),false);assert.equal(h.get('approval').open,false);
  await h.poll();assert.equal(posts(h).length,0);
});

test('missing pending draft does not block restoring an existing owner-scoped task',async()=>{
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot([{id:'existing-task'}]));
    if(r.path==='/api/policy/drafts/'+id)return {status:404,body:{error:'Not found'}};
    if(r.path==='/api/tasks/existing-task')return reply(task('existing-task'));
    return shared(r);
  }});
  assert.equal(h.storage.has('mg-pending-approval'),false);
  assert.equal(h.storage.get('mg-task-id'),'existing-task');assert.equal(posts(h).length,0);
});

test('rapid repeated approval clicks issue one request while the first is in flight',async()=>{
  let resolveApproval;
  const response=new Promise(resolve=>{resolveApproval=resolve;});
  const h=await startController({stored:stored(),respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/drafts/'+id)return reply(draft());
    if(r.path==='/api/tasks/approve-and-enqueue')return response;
    return shared(r);
  }});
  const first=h.fire('approve','click');
  await h.flush();assert.equal(h.get('approve').disabled,true);
  await h.fire('approve','click');await h.poll();assert.equal(posts(h).length,1);
  resolveApproval(reply(task()));await first;
  assert.equal(h.storage.has('mg-pending-approval'),false);
});

test('storage denial warns and keeps an in-memory identical retry after a lost response',async()=>{
  let attempts=0;
  const h=await startController({storageThrows:true,respond:r=>{
    if(r.path==='/api/bootstrap')return reply(boot());
    if(r.path==='/api/policy/draft')return reply(draft());
    if(r.path==='/api/tasks/approve-and-enqueue')return ++attempts===1?{error:Error('Lost')}:reply(task());
    return shared(r);
  }});
  await h.fire('policy-form','submit');h.get('ack').checked=true;await h.fire('ack','change');
  await h.fire('approve','click');assert.match(h.get('action-error-copy').textContent,/saklama alanı kapalı/);
  await h.poll();await h.fire('approve','click');
  const approvals=posts(h).filter(r=>r.path.endsWith('approve-and-enqueue'));
  assert.equal(approvals.length,2);assert.equal(approvals[0].body,approvals[1].body);
  assert.equal(h.get('workspace').hidden,false);
});

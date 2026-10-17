// Shipped controller + deterministic doubles, not real-browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';
import {parsePendingStops} from '../public/ui-state.mjs';

const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const status={executionMode:'fixture',safety:{paused:false},extractorAvailable:false};
const policy={executionMode:'fixture',accountId:'fixture',budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
  approvedAtMs:500,expiresAtMs:600000,orderLifetimeMs:10000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:1000,
  quoteFeeRateMax:'0.001',quoteFeeFixedMax:'0',baseFeeRateMax:'0.001'};
const task=(id,stopRequested=false,revision=1)=>({id,revision,mode:'fixture',plannerKind:'fixture',policy,approvedPolicyHash:'a'.repeat(64),
  ledger:{phase:stopRequested?'STOPPED':'RUNNING',intents:[],stopRequested},queueInfo:{state:'RELEASED'},
  summary:{spent:'0',reserved:'0',remaining:'100'},receipts:[],auditVerified:true});
const reply=body=>({body});
const boot=(ids=[a,b])=>({csrf:'fixture-csrf',status,tasks:ids.map(id=>({id})),drafts:[]});
const posts=h=>h.calls.filter(r=>r.method==='POST');
const choose=async(h,id)=>{h.get('saved-tasks').value=id;await h.fire('saved-tasks','change');};
async function setup({stored=[],storageThrows=false,respond=()=>undefined,ids=[a,b]}={}) {
  return startController({stored,storageThrows,respond:r=>respond(r)??(
    r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot(ids)):
    r.path==='/api/status'?reply(status):
    ids.some(id=>r.path==='/api/tasks/'+id)?reply(task(r.path.split('/').at(-1))):undefined)});
}

test('two lost stop responses retain both warnings; confirming one does not clear the other',async()=>{
  let confirmed=false;
  const h=await setup({respond:r=>{
    if(r.path.endsWith('/stop'))return {error:Error('Lost response')};
    if(r.path==='/api/tasks/'+b && confirmed)return reply(task(b,true,2));
  }});
  await h.fire('stop','click');await h.poll();await choose(h,b);
  assert.match(h.get('notice').textContent,/Başka bir görevde.*aaaaaaaa/);
  await h.fire('stop','click');confirmed=true;await h.poll();
  assert.match(h.get('notice').textContent,/Başka bir görevde.*aaaaaaaa/);
  await choose(h,a);assert.match(h.get('notice').textContent,/^Durdurma isteği doğrulanmadı/);
  assert.equal(posts(h).length,2);
});

test('lost stop survives controller reload; status success does not authorize run or automatic stop',async()=>{
  const h=await setup({respond:r=>r.path.endsWith('/stop')?{error:Error('Lost')}:undefined});
  await h.fire('stop','click');
  const restored=await setup({stored:[...h.storage]});await restored.poll();
  assert.match(restored.get('notice').textContent,/^Durdurma isteği doğrulanmadı/);
  assert.equal(restored.get('advance').disabled,true);
  assert.equal(restored.get('draft-button').disabled,true);
  assert.equal(restored.get('leave-session').disabled,true);
  await restored.fire('advance','click');await restored.fire('policy-form','submit');
  assert.equal(posts(restored).length,0);
  assert.equal(restored.get('stop').disabled,false);
});

test('stop is remembered before response so a reload during the request can reconcile with GET',async()=>{
  let resolveStop;
  const response=new Promise(resolve=>{resolveStop=resolve;});
  const h=await setup({respond:r=>r.path.endsWith('/stop')?response:undefined});
  const stop=h.fire('stop','click');await h.flush();
  const restored=await setup({stored:[...h.storage]});
  assert.match(restored.get('notice').textContent,/^Durdurma isteği doğrulanmadı/);
  assert.equal(posts(restored).length,0);
  resolveStop(reply(task(a,true,2)));await stop;
});

test('confirmed stop with UNKNOWN intent retains reserve and never claims exchange cancellation',async()=>{
  const state=task(a,true,2);state.ledger.phase='STOP_REQUESTED';state.queueInfo.state='RUNNING';
  state.ledger.intents=[{state:'UNKNOWN',settled:false,clOrdId:'fixture-client',payload:{px:'25',sz:'1'}}];
  state.summary={spent:'0',reserved:'25.025',remaining:'74.975'};
  const h=await setup({respond:r=>r.path.endsWith('/stop')?reply(state):undefined});
  await h.fire('stop','click');
  assert.match(h.get('task-state').textContent,/belirsiz/);
  assert.match(h.get('task-summary').textContent,/25,025 USDT/);
  assert.match(h.get('task-warning').textContent,/iptal edildiğini kanıtlamaz/);
  assert.equal(h.get('new-task').hidden,true);assert.equal(posts(h).length,1);
});

test('repeated stop clicks while in flight send only one request',async()=>{
  let resolveStop;
  const response=new Promise(resolve=>{resolveStop=resolve;});
  const h=await setup({respond:r=>r.path.endsWith('/stop')?response:undefined});
  const first=h.fire('stop','click');await h.flush();
  assert.equal(h.get('stop').disabled,true);await h.fire('stop','click');
  assert.equal(posts(h).length,1);resolveStop(reply(task(a,true,2)));await first;
});

test('old poll response cannot erase a newer confirmed stop',async()=>{
  let resolveRead,reads=0;
  const response=new Promise(resolve=>{resolveRead=resolve;});
  const h=await setup({respond:r=>{
    if(r.path==='/api/tasks/'+a && ++reads>1)return response;
    if(r.path.endsWith('/stop'))return reply(task(a,true,3));
  }});
  await h.poll();await h.fire('stop','click');
  resolveRead(reply(task(a,false,1)));await h.flush();
  assert.equal(h.get('task-state').textContent,'Durduruldu');
  assert.equal(h.get('advance').disabled,true);
});

test('late task selection response cannot replace the most recently selected task',async()=>{
  let resolveRead;
  const response=new Promise(resolve=>{resolveRead=resolve;});
  const h=await setup({respond:r=>r.path==='/api/tasks/'+b?response:undefined});
  const earlier=choose(h,b);await h.flush();await choose(h,a);
  resolveRead(reply(task(b)));await earlier;
  assert.equal(h.storage.get('mg-task-id'),a);
});

test('stored stop IDs are validated, deduplicated and filtered through the authenticated owner list',async()=>{
  assert.deepEqual(parsePendingStops(JSON.stringify([a,a,b])),[a,b]);
  for(const value of ['broken','null','{}',JSON.stringify([{}]),JSON.stringify(['-'.repeat(36)]),JSON.stringify([a,'../other'])])
    assert.deepEqual(parsePendingStops(value),[]);
  const h=await setup({ids:[b],stored:[['mg-pending-stops',JSON.stringify([a])]]});
  assert.equal(h.storage.has('mg-pending-stops'),false);
  assert.equal(h.calls.some(r=>r.path.includes(a)),false);
  assert.doesNotMatch(h.get('notice').textContent,/durdurma isteği/i);
});

test('fresh definitive stop rejection removes its reminder but cannot clear an earlier ambiguous request',async()=>{
  const respond=r=>r.path.endsWith('/stop')?{status:409,body:{error:'Stop refused'}}:undefined;
  const fresh=await setup({respond});await fresh.fire('stop','click');
  assert.equal(fresh.storage.has('mg-pending-stops'),false);
  assert.equal(fresh.get('advance').disabled,false);
  const prior=await setup({respond,stored:[['mg-pending-stops',JSON.stringify([a])]]});
  await prior.fire('stop','click');
  assert.deepEqual(JSON.parse(prior.storage.get('mg-pending-stops')),[a]);
  assert.equal(prior.get('advance').disabled,true);
});

test('storage denial retains the in-memory warning and explicitly warns against reload',async()=>{
  const h=await setup({storageThrows:true,respond:r=>r.path.endsWith('/stop')?{error:Error('Lost')}:undefined});
  await h.fire('stop','click');await h.poll();
  assert.match(h.get('notice').textContent,/^Durdurma isteği doğrulanmadı/);
  assert.match(h.get('action-error-copy').textContent,/saklama alanı kapalı.*yenileme/);
  assert.equal(h.get('advance').disabled,true);assert.equal(posts(h).length,1);
});

test('offline stop remains available; a verified stop clears only request uncertainty',async()=>{
  const h=await setup({respond:r=>r.path.endsWith('/stop')?reply(task(a,true,2)):undefined});
  await h.window.fire('offline');await h.flush();
  assert.equal(h.get('advance').disabled,true);assert.equal(h.get('stop').disabled,false);
  await h.fire('stop','click');
  assert.equal(posts(h).length,1);assert.equal(h.storage.has('mg-pending-stops'),false);
  assert.equal(h.get('task-state').textContent,'Durduruldu');
});

test('poll 401 clears stop reminders and private task display, without retrying a mutation',async()=>{
  const h=await setup({stored:[['mg-pending-stops',JSON.stringify([a])]],respond:r=>
    r.path==='/api/status'?{status:401,body:{error:'Session expired',inviteRequired:true}}:undefined});
  await h.poll();
  assert.equal(h.get('visitor-access').hidden,false);assert.equal(h.get('workspace').hidden,true);
  assert.equal(h.storage.has('mg-pending-stops'),false);assert.equal(posts(h).length,0);
});

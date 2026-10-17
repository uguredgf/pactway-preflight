// Shipped app controller with deterministic doubles; no browser or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';

const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const status={executionMode:'fixture',extractorAvailable:true,safety:{paused:false}};
const policy={executionMode:'fixture',accountId:'fixture',budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
  approvedAtMs:500,expiresAtMs:600000,orderLifetimeMs:10000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:1000,
  quoteFeeRateMax:'0.001',quoteFeeFixedMax:'0',baseFeeRateMax:'0.001'};
const draft=(id=a,patch={})=>({id,revision:1,policyHash:'a'.repeat(64),policy,ready:true,missing:[],unresolved:[],
  extractionState:'NOT_REQUESTED',validUntilMs:500000,originalText:'100 USDT bütçe',
  fields:{budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'},...patch});
const reply=body=>({body});
const boot=()=>({csrf:'fixture-csrf',status,tasks:[],drafts:[{id:a,ready:true},{id:b,ready:true}]});
const mutations=h=>h.calls.filter(r=>r.method==='POST');
async function setup(respond=()=>undefined){
  return startController({stored:[['mg-draft-id',a]],respond:r=>respond(r)??(
    r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot()):r.path==='/api/status'?reply(status):
    [a,b].some(id=>r.path==='/api/policy/drafts/'+id)?reply(draft(r.path.split('/').at(-1))):undefined)});
}
async function acknowledge(h){h.get('ack').checked=true;await h.fire('ack','change');}

test('lost extraction plus failed recovery GET cannot re-enable approval from stale policy after reconnect',async()=>{
  let failed=false;
  const h=await setup(r=>{
    if(r.path.endsWith('/extract')){failed=true;return {error:Error('Lost response')};}
    if(failed && r.path==='/api/policy/drafts/'+a)return {error:Error('Read failed')};
  });
  await acknowledge(h);await h.fire('extract-draft','click');await h.poll();
  await acknowledge(h);
  assert.equal(h.get('approve').disabled,true);
  assert.equal(h.get('ack').disabled,true);
  assert.equal(h.get('save-draft').disabled,true);
  assert.equal(h.get('extract-draft').disabled,true);
  assert.equal(h.get('refresh-draft').disabled,false);
  await h.fire('approve','click');await h.fire('extract-draft','click');
  assert.equal(mutations(h).length,1);
});

test('lost edit recovers by GET without repeating POST and requires acknowledgement of updated policy',async()=>{
  let edited=false;
  const h=await setup(r=>{
    if(r.path.endsWith('/edit')){edited=true;return {error:Error('Lost')};}
    if(edited && r.path==='/api/policy/drafts/'+a)return reply(draft(a,{revision:2,policyHash:'b'.repeat(64),policy:{...policy,budget:'80'},fields:{...draft().fields,budget:'80'}}));
  });
  h.get('draft-edit-form').elements.namedItem('budget').value='80';
  await h.fire('draft-edit-form','input');await h.fire('draft-edit-form','submit');
  assert.equal(mutations(h).length,1);
  assert.equal(JSON.parse(mutations(h)[0].body).fields.budget,'80');
  assert.equal(h.get('ack').checked,false);assert.equal(h.get('approve').disabled,true);
  assert.match(h.get('approval-hash').textContent,/bbbbbbbb/);
  await acknowledge(h);assert.equal(h.get('approve').disabled,false);
  assert.equal(mutations(h).length,1);
});

test('lost extraction revealing RUNNING consumes no second slot and stays unapprovable',async()=>{
  let started=false;
  const h=await setup(r=>{
    if(r.path.endsWith('/extract')){started=true;return {error:Error('Lost')};}
    if(started && r.path==='/api/policy/drafts/'+a)return reply(draft(a,{revision:2,ready:false,extractionState:'RUNNING',usage:{total:1,extraction:1}}));
  });
  await h.fire('extract-draft','click');await h.poll();
  assert.equal(h.get('approve').disabled,true);assert.equal(h.get('extract-draft').disabled,true);
  assert.match(h.get('draft-usage').textContent,/kullanılan 1\/3 · çıkarım 1\/1/);
  assert.equal(mutations(h).length,1);
});

test('in-flight extraction locks editor and cancel and ignores repeated requests',async()=>{
  let resolveExtract;
  const response=new Promise(resolve=>{resolveExtract=resolve;});
  const h=await setup(r=>r.path.endsWith('/extract')?response:undefined);
  await h.fire('extract-draft','click');
  for(const id of ['save-draft','extract-draft','close-approval','approve'])assert.equal(h.get(id).disabled,true,id);
  assert.ok(h.get('draft-edit-form').querySelectorAll('input').every(input=>input.disabled));
  assert.equal((await h.fire('approval','cancel')).defaultPrevented,true);
  await h.fire('extract-draft','click');assert.equal(mutations(h).length,1);
  resolveExtract(reply(draft(a,{revision:2,extractionState:'COMPLETED'})));await h.flush();
  assert.equal(h.get('ack').checked,false);assert.equal(h.get('close-approval').disabled,false);
});

test('late extraction response after session expiry cannot reopen a private draft',async()=>{
  let resolveExtract,expired=false;
  const response=new Promise(resolve=>{resolveExtract=resolve;});
  const h=await setup(r=>{
    if(r.path.endsWith('/extract'))return response;
    if(r.path==='/api/status' && expired)return {status:401,body:{error:'Expired',inviteRequired:true}};
  });
  await h.fire('extract-draft','click');expired=true;await h.poll();
  resolveExtract(reply(draft(a,{revision:2,extractionState:'COMPLETED'})));await h.flush();
  assert.equal(h.get('approval').open,false);assert.equal(h.get('visitor-access').hidden,false);
  assert.equal(h.storage.has('mg-draft-id'),false);assert.equal(mutations(h).length,1);
});

test('opening a different draft does not carry a previous draft failure into its review',async()=>{
  const h=await setup(r=>r.path.endsWith('/extract')?{status:409,body:{error:'Önceki taslak çıkarımı reddedildi.'}}:undefined);
  await h.fire('extract-draft','click');await h.fire('close-approval','click');
  h.get('saved-drafts').value=b;await h.fire('saved-drafts','change');
  assert.equal(h.storage.get('mg-draft-id'),b);
  assert.equal(h.get('approval-error').textContent,'');
});

test('explicit successful refresh clears the read requirement but never restores old acknowledgement',async()=>{
  let started=false,recovered=false;
  const h=await setup(r=>{
    if(r.path.endsWith('/extract')){started=true;return {error:Error('Lost')};}
    if(started && r.path==='/api/policy/drafts/'+a)return recovered?
      reply(draft(a,{revision:2,extractionState:'COMPLETED',policyHash:'c'.repeat(64)})):{error:Error('Read failed')};
  });
  await acknowledge(h);await h.fire('extract-draft','click');await h.poll();
  assert.equal(h.get('ack').disabled,true);
  recovered=true;await h.fire('refresh-draft','click');
  assert.equal(h.get('ack').disabled,false);assert.equal(h.get('ack').checked,false);
  assert.equal(h.get('approve').disabled,true);assert.equal(h.get('approval-error').textContent,'');
  assert.match(h.get('approval-hash').textContent,/cccccccc/);
  await acknowledge(h);assert.equal(h.get('approve').disabled,false);
  assert.equal(mutations(h).length,1);
});

test('a response older than the displayed revision cannot clear the review-read requirement',async()=>{
  const h=await setup(r=>{
    if(r.path.endsWith('/extract'))return reply(draft(a,{revision:1,policyHash:'b'.repeat(64)}));
    if(r.path==='/api/policy/drafts/'+a)return reply(draft(a,{revision:3}));
  });
  await h.fire('extract-draft','click');
  assert.match(h.get('approval-hash').textContent,/aaaaaaaa/);
  assert.equal(h.get('ack').disabled,true);assert.equal(h.get('approve').disabled,true);
  await h.fire('refresh-draft','click');
  assert.equal(h.get('ack').disabled,false);assert.equal(h.get('ack').checked,false);
});

test('unread result is scoped to its draft and does not prevent reviewing another known draft',async()=>{
  let failed=false;
  const h=await setup(r=>{
    if(r.path.endsWith('/extract')){failed=true;return {error:Error('Lost')};}
    if(failed && r.path==='/api/policy/drafts/'+a)return {error:Error('Offline read')};
  });
  await h.fire('extract-draft','click');await h.poll();
  assert.equal(h.get('close-approval').disabled,false);await h.fire('close-approval','click');
  h.get('saved-drafts').value=b;await h.fire('saved-drafts','change');
  assert.equal(h.get('approval-error').textContent,'');await acknowledge(h);
  assert.equal(h.get('approve').disabled,false);assert.equal(h.storage.get('mg-draft-id'),b);
  assert.equal(mutations(h).length,1);
});

test('lost draft creation requires explicit work-list reconciliation and never auto-creates again',async()=>{
  const h=await startController({respond:r=>{
    if(r.path==='/api/bootstrap' || r.path==='/api/work')return reply({...boot(),drafts:[]});
    if(r.path==='/api/status')return reply(status);
    if(r.path==='/api/policy/draft')return {error:Error('Lost creation')};
  }});
  await h.fire('policy-form','submit');await h.poll();
  assert.equal(h.get('saved-work').hidden,false);assert.equal(h.get('draft-button').disabled,true);
  await h.fire('policy-form','submit');assert.equal(mutations(h).length,1);
  await h.fire('refresh-work','click');
  assert.equal(h.get('draft-button').disabled,false);assert.equal(mutations(h).length,1);
});
